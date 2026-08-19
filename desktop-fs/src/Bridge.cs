using System;
using System.Buffers;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace TmaCloud.Fs
{
    /// <summary>
    /// Thrown when the Electron bridge returns an error for a request, or the
    /// pipe connection fails. Message carries the backend error text.
    /// </summary>
    public sealed class BridgeException : Exception
    {
        public BridgeException(string message) : base(message) { }
    }

    /// <summary>
    /// JSON-RPC client over a Windows named pipe to the Electron main process.
    ///
    /// Protocol: newline-delimited UTF-8 JSON. Each request is one line:
    ///   { "rid": &lt;int&gt;, "op": "&lt;name&gt;", ...args }
    /// Each response is one line:
    ///   { "rid": &lt;int&gt;, "ok": true,  "result": &lt;any&gt; }
    ///   { "rid": &lt;int&gt;, "ok": false, "error": "&lt;text&gt;" }
    ///
    /// Bulk file bytes never travel on the pipe. For reads/writes we exchange
    /// temp-file paths on local disk (both processes share %TEMP%): Electron
    /// downloads into a path we give it; we stage uploads to a path Electron
    /// then streams. The pipe only carries control messages.
    ///
    /// WinFsp dispatches filesystem callbacks from multiple worker threads, so
    /// this client supports concurrent in-flight requests: a single reader
    /// thread demultiplexes responses by id and completes the matching waiter.
    /// </summary>
    public sealed class Bridge : IDisposable
    {
        // Response lines are control messages, never bulk content, so anything
        // near this is a peer streaming bytes that never terminate.
        private const int MaxLineBytes = 8 * 1024 * 1024;

        private readonly string _pipeName;
        private readonly string _token;
        private NamedPipeClientStream _pipe;
        private volatile bool _closed;

        // Set once the reader loop ends. Without it every later call ties up a
        // WinFsp worker thread for the full timeout on a dead connection.
        private volatile bool _faulted;
        private volatile string _faultReason;

        /// <summary>
        /// Raised for unsolicited server-to-client messages (no "rid"), e.g.
        /// cache invalidation forwarded from the backend's event stream. The
        /// argument is the parsed message object.
        /// </summary>
        public Action<JsonElement> OnPush;

        private int _nextId;
        private readonly object _writeLock = new object();
        private readonly ConcurrentDictionary<int, Waiter> _pending =
            new ConcurrentDictionary<int, Waiter>();

        private sealed class Waiter : IDisposable
        {
            public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
            public JsonElement Result;
            public bool Ok;
            public string Error;
            public void Dispose() => Done.Dispose();
        }

        public Bridge(string pipeName, string token = null)
        {
            // Accept either a bare name or a full \\.\pipe\ path.
            const string prefix = @"\\.\pipe\";
            if (pipeName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                pipeName = pipeName.Substring(prefix.Length);
            _pipeName = pipeName;
            _token = token;
        }

        public void Connect(int timeoutMs = 15000)
        {
            // Asynchronous (overlapped) pipe is REQUIRED for concurrent
            // read+write on one handle: a blocking read on a synchronous handle
            // would block all writes, so the request that produces the reply
            // could never be sent.
            //
            // Impersonation level is explicit, not defaulted: whatever answers
            // on this pipe must not be able to borrow our security context.
            var pipe = new NamedPipeClientStream(".", _pipeName,
                PipeDirection.InOut, PipeOptions.Asynchronous,
                TokenImpersonationLevel.None);
            try
            {
                pipe.Connect(timeoutMs);
            }
            catch
            {
                // A failed Connect leaves the handle open until finalization.
                try { pipe.Dispose(); } catch { /* nothing left to do */ }
                throw;
            }
            _pipe = pipe;
            // Genuine async read loop. Using .GetAwaiter().GetResult() to pump
            // overlapped reads on a plain thread deadlocks after the first
            // completion, so the loop must actually await.
            _ = System.Threading.Tasks.Task.Run(ReadLoopAsync);
        }

        // Manual newline framing over the raw pipe using the async I/O APIs.
        // StreamReader/StreamWriter over an overlapped (Asynchronous) pipe stall
        // after the first synchronous read, so we avoid them entirely.
        private async System.Threading.Tasks.Task ReadLoopAsync()
        {
            byte[] buffer = ArrayPool<byte>.Shared.Rent(65536);
            // Grown on demand up to MaxLineBytes; pooled because a busy mount
            // reads continuously for the life of the drive.
            byte[] acc = ArrayPool<byte>.Shared.Rent(4096);
            int accLen = 0;
            string reason = "pipe closed by host";
            try
            {
                while (!_closed)
                {
                    int n = await _pipe.ReadAsync(buffer.AsMemory(0, buffer.Length)).ConfigureAwait(false);
                    if (n <= 0) break; // EOF
                    for (int i = 0; i < n; i++)
                    {
                        byte b = buffer[i];
                        if (b == (byte)'\n')
                        {
                            if (accLen > 0)
                            {
                                HandleLine(Encoding.UTF8.GetString(acc, 0, accLen));
                                accLen = 0;
                            }
                        }
                        else if (b != (byte)'\r')
                        {
                            if (accLen == acc.Length)
                            {
                                if (acc.Length >= MaxLineBytes)
                                    throw new IOException("bridge sent an oversized line");
                                byte[] bigger = ArrayPool<byte>.Shared.Rent(
                                    Math.Min(acc.Length * 2, MaxLineBytes));
                                Buffer.BlockCopy(acc, 0, bigger, 0, accLen);
                                ArrayPool<byte>.Shared.Return(acc);
                                acc = bigger;
                            }
                            acc[accLen++] = b;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                reason = "pipe read failed: " + ex.Message;
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(buffer);
                ArrayPool<byte>.Shared.Return(acc);
                if (!_closed)
                {
                    // Before releasing the waiters, so a thread woken by FailAll
                    // can't queue a request that would only sit until timeout.
                    _faultReason = reason;
                    _faulted = true;
                    FailAll(reason);
                }
            }
        }

        private void HandleLine(string line)
        {
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object) return;
                // "rid" is the RPC correlation id - deliberately distinct from
                // any "id" argument (e.g. a file id) an op may also carry.
                if (!root.TryGetProperty("rid", out var idEl))
                {
                    // Unsolicited server push (e.g. { "push": "invalidate" }).
                    if (root.TryGetProperty("push", out _))
                    {
                        try { OnPush?.Invoke(root.Clone()); } catch { /* ignore */ }
                    }
                    return;
                }
                // Malformed rid: skip the reply, don't kill the read loop.
                if (idEl.ValueKind != JsonValueKind.Number || !idEl.TryGetInt32(out int id)) return;
                if (!_pending.TryRemove(id, out var waiter)) return;

                waiter.Ok = root.TryGetProperty("ok", out var okEl)
                    && okEl.ValueKind == JsonValueKind.True;
                if (waiter.Ok)
                {
                    // Clone so the value survives disposal of the JsonDocument.
                    waiter.Result = root.TryGetProperty("result", out var res)
                        ? res.Clone() : default;
                }
                else
                {
                    waiter.Error = root.TryGetProperty("error", out var err)
                        && err.ValueKind == JsonValueKind.String
                        ? err.GetString() : "bridge error";
                }
                Complete(waiter);
            }
            catch
            {
                // Malformed line - ignore; the request will time out.
            }
        }

        private void FailAll(string reason)
        {
            foreach (var kv in _pending)
            {
                if (_pending.TryRemove(kv.Key, out var w))
                {
                    w.Ok = false;
                    w.Error = reason;
                    Complete(w);
                }
            }
        }

        // Whoever wins TryRemove owns the waiter and alone may signal it. Call()
        // disposes only when it won, so the guard covers only an abandoned wait.
        private static void Complete(Waiter w)
        {
            try { w.Done.Set(); } catch (ObjectDisposedException) { /* caller gave up */ }
        }

        /// <summary>
        /// Send a request and block until the matching response arrives.
        /// Called from WinFsp worker threads. Throws BridgeException on error.
        /// </summary>
        public JsonElement Call(string op, Action<Utf8JsonWriter> writeArgs = null, int timeoutMs = 120000)
        {
            if (_closed) throw new BridgeException("bridge is closed");
            if (_faulted) throw new BridgeException(_faultReason ?? "bridge connection lost");

            int id = Interlocked.Increment(ref _nextId);
            var waiter = new Waiter();
            _pending[id] = waiter;
            try
            {
                var buffer = new ArrayBufferWriter<byte>(256);
                using (var jw = new Utf8JsonWriter(buffer))
                {
                    jw.WriteStartObject();
                    jw.WriteNumber("rid", id);
                    if (_token != null) jw.WriteString("token", _token);
                    jw.WriteString("op", op);
                    writeArgs?.Invoke(jw);
                    jw.WriteEndObject();
                }
                var span = buffer.WrittenSpan;
                byte[] frame = ArrayPool<byte>.Shared.Rent(span.Length + 1);
                try
                {
                    span.CopyTo(frame);
                    frame[span.Length] = (byte)'\n';
                    lock (_writeLock)
                    {
                        _pipe.WriteAsync(frame, 0, span.Length + 1).GetAwaiter().GetResult();
                        _pipe.FlushAsync().GetAwaiter().GetResult();
                    }
                }
                finally { ArrayPool<byte>.Shared.Return(frame); }

                if (!waiter.Done.Wait(timeoutMs))
                    throw new BridgeException($"bridge call '{op}' timed out");
                if (!waiter.Ok)
                    throw new BridgeException(waiter.Error ?? "bridge error");
                return waiter.Result;
            }
            catch (BridgeException) { throw; }
            catch (Exception ex)
            {
                // Callers only handle BridgeException, so a pipe that died
                // mid-write must not escape into a WinFsp callback raw.
                throw new BridgeException($"bridge call '{op}' failed: {ex.Message}");
            }
            finally
            {
                // Removal transfers ownership: win and no completer holds it,
                // so disposal is safe; lose and the GC reclaims it instead.
                if (_pending.TryRemove(id, out _)) waiter.Dispose();
            }
        }

        public void Dispose()
        {
            _closed = true;
            try { _pipe?.Dispose(); } catch { /* already gone */ }
            _pipe = null;
            // Stop holding the filesystem (and all it references) alive.
            OnPush = null;
            FailAll("bridge disposed");
        }
    }
}
