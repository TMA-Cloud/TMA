/*
 * The PowerShell/C# script that extracts OLE clipboard file contents
 * (Outlook attachments, Snipping Tool images, "virtual" files that live only
 * in the clipboard as FileGroupDescriptor + FileContents rather than on disk).
 *
 * The real script ships as src/main/utils/extract-ole-clipboard.ps1 and is read
 * once and cached. The inlined fallback below is used only if that file is
 * missing from the package, so the feature degrades instead of breaking.
 */
const path = require('path');
const fs = require('fs');

let _cachedOleScript = null;
function getOleExtractScriptContent() {
  if (_cachedOleScript != null) return _cachedOleScript;
  try {
    const p = path.join(__dirname, '..', '..', 'utils', 'extract-ole-clipboard.ps1');
    _cachedOleScript = fs.readFileSync(p, 'utf8');
  } catch (_) {
    _cachedOleScript = OLE_EXTRACT_SCRIPT_FALLBACK;
  }
  return _cachedOleScript;
}

/* eslint-disable no-useless-escape -- embedded C# string needs \" for JSON output */
const OLE_EXTRACT_SCRIPT_FALLBACK = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.InteropServices
$code = @'
using System;using System.Collections.Generic;using System.IO;using System.Runtime.InteropServices;using System.Runtime.InteropServices.ComTypes;using System.Text;using System.Windows.Forms;
public static class OleClipboardHelper{[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct FILEDESCRIPTORW{public uint dwFlags;public Guid clsid;public int sizel_cx,sizel_cy,pointl_x,pointl_y;public uint dwFileAttributes;public long ftCreationTime,ftLastAccessTime,ftLastWriteTime;public uint nFileSizeHigh,nFileSizeLow;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string cFileName;}
[ComImport,Guid("0000000A-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]interface ILockBytes{void ReadAt([In]long ulOffset,[Out]byte[] pv,[In]int cb,[Out]int[] pcbRead);void WriteAt([In]long ulOffset,IntPtr pv,[In]int cb,[Out]int[] pcbWritten);void Flush();void SetSize([In]long cb);void LockRegion([In]long libOffset,[In]long cb,[In]int dwLockType);void UnlockRegion([In]long libOffset,[In]long cb,[In]int dwLockType);void Stat([Out]out System.Runtime.InteropServices.ComTypes.STATSTG pstatstg,[In]int grfStatFlag);}
[ComImport,InterfaceType(ComInterfaceType.InterfaceIsIUnknown),Guid("0000000B-0000-0000-C000-000000000046")]interface IStorage{void CopyTo([In]int ciidExclude,[In]Guid[] pIIDExclude,IntPtr snbExclude,[In]IStorage stgDest);void Commit([In]int grfCommitFlags);void Stat([Out]out System.Runtime.InteropServices.ComTypes.STATSTG pStatStg,[In]int grfStatFlag);}
[DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern uint RegisterClipboardFormat(string lpszFormat);
[DllImport("ole32.dll",PreserveSig=false)]static extern void CreateILockBytesOnHGlobal(IntPtr hGlobal,[MarshalAs(UnmanagedType.Bool)]bool fDeleteOnRelease,out ILockBytes ppLkbyt);
[DllImport("ole32.dll",PreserveSig=false)]static extern void StgCreateDocfileOnILockBytes(ILockBytes plkbyt,uint grfMode,uint reserved,out IStorage ppstg);
[DllImport("kernel32.dll")]static extern IntPtr GlobalLock(IntPtr hMem);[DllImport("kernel32.dll")]static extern bool GlobalUnlock(IntPtr hMem);[DllImport("kernel32.dll")]static extern IntPtr GlobalSize(IntPtr hMem);
public static string ExtractToJson(){var list=new List<string>();try{var data=Clipboard.GetDataObject();if(data==null)return "{}";string[] names=null;if(data.GetDataPresent("FileGroupDescriptorW")){var ms=data.GetData("FileGroupDescriptorW") as MemoryStream;if(ms!=null&&ms.Length>=4){var buf=new byte[ms.Length];ms.Read(buf,0,buf.Length);uint cItems=BitConverter.ToUInt32(buf,0);int fdSize=Marshal.SizeOf(typeof(FILEDESCRIPTORW));names=new string[cItems];for(uint i=0;i<cItems;i++){int off=4+(int)i*fdSize;if(off+fdSize>buf.Length)break;IntPtr p=Marshal.AllocHGlobal(fdSize);try{Marshal.Copy(buf,off,p,fdSize);var fd=(FILEDESCRIPTORW)Marshal.PtrToStructure(p,typeof(FILEDESCRIPTORW));names[i]=string.IsNullOrWhiteSpace(fd.cFileName)?"file"+i:fd.cFileName;}finally{Marshal.FreeHGlobal(p);}}}}else if(data.GetDataPresent("FileGroupDescriptor")){var ms=data.GetData("FileGroupDescriptor") as MemoryStream;if(ms!=null&&ms.Length>=4){var buf=new byte[ms.Length];ms.Read(buf,0,buf.Length);uint cItems=BitConverter.ToUInt32(buf,0);int fdSize=324;names=new string[cItems];for(uint i=0;i<cItems;i++){int off=4+(int)i*fdSize+72;if(off+260>buf.Length)break;var sb=new StringBuilder();for(int j=0;j<260&&off+j<buf.Length;j++){if(buf[off+j]==0)break;sb.Append((char)buf[off+j]);}names[i]=sb.Length>0?sb.ToString():"file"+i;}}}
if(names!=null&&names.Length>0){var com=(System.Runtime.InteropServices.ComTypes.IDataObject)data;uint cf=RegisterClipboardFormat("FileContents");if(cf!=0){for(int i=0;i<names.Length;i++){var bytes=GetFileContents(com,(short)cf,i);if(bytes!=null&&bytes.Length>0)list.Add("\\""+names[i].Replace("\\\\","\\\\\\\\").Replace("\\"","\\\\\\"")+"\\":\\""+Convert.ToBase64String(bytes)+"\\"");}}}if(list.Count==0){var img=data.GetData(DataFormats.Bitmap) as System.Drawing.Image;if(img==null)img=Clipboard.GetImage();if(img!=null){try{using(var ms=new MemoryStream()){img.Save(ms,System.Drawing.Imaging.ImageFormat.Png);var b=ms.ToArray();if(b.Length>0)list.Add("\\\"clipboard-image.png\\\":\\\""+Convert.ToBase64String(b)+"\\\"");}}finally{img.Dispose();}}}catch{}return "{"+string.Join(",",list)+"}";}
static byte[] GetFileContents(System.Runtime.InteropServices.ComTypes.IDataObject data,short cf,int index){try{var fmt=new FORMATETC();fmt.cfFormat=cf;fmt.dwAspect=DVASPECT.DVASPECT_CONTENT;fmt.lindex=index;fmt.ptd=IntPtr.Zero;fmt.tymed=TYMED.TYMED_HGLOBAL|TYMED.TYMED_ISTREAM|TYMED.TYMED_ISTORAGE;STGMEDIUM med;data.GetData(ref fmt,out med);try{if(med.tymed==TYMED.TYMED_HGLOBAL){IntPtr p=GlobalLock(med.unionmember);if(p==IntPtr.Zero)return null;try{int sz=GlobalSize(med.unionmember).ToInt32();if(sz<=0||sz>524288000)return null;var b=new byte[sz];Marshal.Copy(p,b,0,sz);return b;}finally{GlobalUnlock(med.unionmember);}}if(med.tymed==TYMED.TYMED_ISTREAM){var stm=(IStream)Marshal.GetObjectForIUnknown(med.unionmember);var stat=new System.Runtime.InteropServices.ComTypes.STATSTG();stm.Stat(out stat,0);long sz=stat.cbSize;if(sz<=0||sz>524288000)return null;var b=new byte[(int)sz];stm.Read(b,(int)sz,IntPtr.Zero);return b;}if(med.tymed==TYMED.TYMED_ISTORAGE){var iStg=(IStorage)Marshal.GetObjectForIUnknown(med.unionmember);ILockBytes iLb;IStorage iStg2;CreateILockBytesOnHGlobal(IntPtr.Zero,true,out iLb);StgCreateDocfileOnILockBytes(iLb,0x00001012,0,out iStg2);iStg.CopyTo(0,null,IntPtr.Zero,iStg2);iLb.Flush();iStg2.Commit(0);System.Runtime.InteropServices.ComTypes.STATSTG st;iLb.Stat(out st,1);long sz=st.cbSize;if(sz<=0||sz>524288000)return null;var b=new byte[(int)sz];int[] rd=new int[1];iLb.ReadAt(0,b,(int)sz,rd);Marshal.ReleaseComObject(iStg2);Marshal.ReleaseComObject(iLb);return b;}}finally{if(med.unionmember!=IntPtr.Zero)Marshal.Release(med.unionmember);}}catch{}return null;}
}'@
Add-Type -TypeDefinition $code -ReferencedAssemblies System.Windows.Forms,System.Drawing
try{$json=[OleClipboardHelper]::ExtractToJson();Write-Output $json}catch{Write-Output "{}"}`;

module.exports = { getOleExtractScriptContent, OLE_EXTRACT_SCRIPT_FALLBACK };
