using System;
using System.Buffers;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
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
    ///   { "id": &lt;int&gt;, "op": "&lt;name&gt;", ...args }
    /// Each response is one line:
    ///   { "id": &lt;int&gt;, "ok": true,  "result": &lt;any&gt; }
    ///   { "id": &lt;int&gt;, "ok": false, "error": "&lt;text&gt;" }
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
        private readonly string _pipeName;
        private readonly string _token;
        private NamedPipeClientStream _pipe;
        private volatile bool _closed;

        /// <summary>
        /// Raised for unsolicited server→client messages (no "rid"), e.g. cache
        /// invalidation forwarded from the backend's event stream. The argument
        /// is the parsed message object.
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
            _pipe = new NamedPipeClientStream(".", _pipeName,
                PipeDirection.InOut, PipeOptions.Asynchronous);
            _pipe.Connect(timeoutMs);
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
            var buffer = new byte[65536];
            var acc = new List<byte>(1024);
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
                            if (acc.Count > 0)
                            {
                                string line = Encoding.UTF8.GetString(acc.ToArray());
                                acc.Clear();
                                HandleLine(line);
                            }
                        }
                        else if (b != (byte)'\r')
                        {
                            acc.Add(b);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                if (!_closed) FailAll("pipe read failed: " + ex.Message);
            }
            finally
            {
                if (!_closed) FailAll("pipe closed by host");
            }
        }

        private void HandleLine(string line)
        {
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                // "rid" is the RPC correlation id — deliberately distinct from
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
                int id = idEl.GetInt32();
                if (!_pending.TryRemove(id, out var waiter)) return;

                waiter.Ok = root.TryGetProperty("ok", out var okEl) && okEl.GetBoolean();
                if (waiter.Ok)
                {
                    // Clone so the value survives disposal of the JsonDocument.
                    waiter.Result = root.TryGetProperty("result", out var res)
                        ? res.Clone() : default;
                }
                else
                {
                    waiter.Error = root.TryGetProperty("error", out var err)
                        ? err.GetString() : "bridge error";
                }
                waiter.Done.Set();
            }
            catch
            {
                // Malformed line — ignore; the request will time out.
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
                    // The waiting thread may have already timed out and disposed
                    // the waiter in the tiny window before we removed it.
                    try { w.Done.Set(); } catch (ObjectDisposedException) { }
                }
            }
        }

        /// <summary>
        /// Send a request and block until the matching response arrives.
        /// Called from WinFsp worker threads. Throws BridgeException on error.
        /// </summary>
        public JsonElement Call(string op, Action<Utf8JsonWriter> writeArgs = null, int timeoutMs = 120000)
        {
            if (_closed) throw new BridgeException("bridge is closed");

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
                byte[] frame = new byte[span.Length + 1];
                span.CopyTo(frame);
                frame[span.Length] = (byte)'\n';

                lock (_writeLock)
                {
                    _pipe.WriteAsync(frame, 0, frame.Length).GetAwaiter().GetResult();
                    _pipe.FlushAsync().GetAwaiter().GetResult();
                }

                if (!waiter.Done.Wait(timeoutMs))
                    throw new BridgeException($"bridge call '{op}' timed out");
                if (!waiter.Ok)
                    throw new BridgeException(waiter.Error ?? "bridge error");
                return waiter.Result;
            }
            finally
            {
                // This thread owns the waiter's lifetime: once we stop waiting
                // (reply, timeout, or throw) remove it so no late reply targets
                // it, then dispose. A completer racing on Done.Set() is guarded
                // at the Set() call sites.
                _pending.TryRemove(id, out _);
                waiter.Dispose();
            }
        }

        public void Dispose()
        {
            _closed = true;
            try { _pipe?.Dispose(); } catch { }
            FailAll("bridge disposed");
        }
    }
}
