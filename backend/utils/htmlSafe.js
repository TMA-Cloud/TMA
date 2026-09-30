/**
 * JSON safe to inline in <script>: plain JSON.stringify lets a value holding
 * "</script>" (e.g. a Google profile name) close the tag and inject markup.
 */
const SCRIPT_UNSAFE = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const jsonForScript = value =>
  JSON.stringify(value).replace(SCRIPT_UNSAFE, ch => '\\' + 'u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));

export { jsonForScript };
