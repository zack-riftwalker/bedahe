package com.badahe.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.WindowManager;
import android.content.ClipData;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Recording, export, share, update. Audio bytes never cross the JS bridge: only paths and names do. */
@CapacitorPlugin(
    name = "Badahe",
    permissions = {
        @Permission(alias = "mic", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
    }
)
public class BadahePlugin extends Plugin {

    private static final String RELEASE_PREFIX = "https://github.com/zack-riftwalker/bedahe/releases/download/";
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private MediaRecorder rec;
    private File recFile;

    private File recDir() {
        return new File(getContext().getFilesDir(), "rec");
    }

    private static boolean badName(String s) {
        return s == null || s.isEmpty() || s.contains("/") || s.contains("\\") || s.contains("..");
    }

    @PluginMethod
    public void info(PluginCall call) throws Exception {
        PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
        JSObject r = new JSObject();
        r.put("name", pi.versionName);
        r.put("code", (int) pi.getLongVersionCode());
        call.resolve(r);
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    /* ---------- recording ---------- */

    @PluginMethod
    public void micPerm(PluginCall call) {
        if (getPermissionState("mic") == PermissionState.GRANTED) micDone(call);
        else requestPermissionForAlias("mic", call, "micDone");
    }

    @PermissionCallback
    private void micDone(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", getPermissionState("mic") == PermissionState.GRANTED);
        call.resolve(r);
    }

    @PluginMethod
    public synchronized void recStart(PluginCall call) {
        int day = call.getInt("day", 0), n = call.getInt("n", 0);
        if (day < 1 || day > 14 || n < 1 || n > 99) { call.reject("bad args"); return; }
        stopQuiet(true);
        File f = new File(recDir(), "d" + day + "/r" + n + ".m4a");
        f.getParentFile().mkdirs();
        try {
            MediaRecorder r = Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(getContext()) : new MediaRecorder();
            r.setAudioSource(MediaRecorder.AudioSource.MIC);
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            r.setAudioChannels(1);
            r.setAudioSamplingRate(44100);
            r.setAudioEncodingBitRate(64000);
            r.setOutputFile(f.getAbsolutePath());
            r.prepare();
            r.start();
            rec = r;
            recFile = f;
            call.resolve();
        } catch (Exception e) {
            f.delete();
            call.reject("rec start failed: " + e);
        }
    }

    @PluginMethod
    public synchronized void recStop(PluginCall call) {
        File f = recFile;
        boolean ok = stopQuiet(false);
        JSObject r = new JSObject();
        r.put("ok", ok);
        if (ok) {
            r.put("path", f.getAbsolutePath());
            r.put("key", f.getParentFile().getName() + "/" + f.getName());
        }
        call.resolve(r);
    }

    @PluginMethod
    public synchronized void recCancel(PluginCall call) {
        stopQuiet(true);
        call.resolve();
    }

    /** Stops the recorder; returns true if a valid file was kept. */
    private boolean stopQuiet(boolean delete) {
        if (rec == null) return false;
        boolean ok = !delete;
        try { rec.stop(); } catch (RuntimeException e) { ok = false; } // stop() throws if nothing was captured
        rec.release();
        rec = null;
        if (!ok && recFile != null) recFile.delete();
        recFile = null;
        return ok;
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (this) { stopQuiet(true); }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void recList(PluginCall call) {
        JSArray out = new JSArray();
        File[] days = recDir().listFiles();
        if (days != null) for (File d : days) {
            File[] fs = d.listFiles();
            if (fs != null) for (File f : fs) if (f.length() > 0) {
                JSObject o = new JSObject();
                o.put("key", d.getName() + "/" + f.getName());
                o.put("path", f.getAbsolutePath());
                out.put(o);
            }
        }
        JSObject r = new JSObject();
        r.put("files", out);
        call.resolve(r);
    }

    /* ---------- export / share ---------- */

    @PluginMethod
    public void save(PluginCall call) {
        if (Build.VERSION.SDK_INT <= 28 && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storageDone");
        } else {
            io.execute(() -> doSave(call));
        }
    }

    @PermissionCallback
    private void storageDone(PluginCall call) {
        if (getPermissionState("storage") == PermissionState.GRANTED) io.execute(() -> doSave(call));
        else call.reject("no storage permission");
    }

    private void doSave(PluginCall call) {
        try {
            String folder = call.getString("folder");
            JSArray files = call.getArray("files");
            JSObject info = call.getObject("info");
            if (badName(folder) || files == null || info == null || badName(info.getString("name"))) throw new Exception("bad args");
            String rel = Environment.DIRECTORY_DOWNLOADS + "/Badahe/" + folder + "/";
            ContentResolver cr = getContext().getContentResolver();
            File dir = null;
            if (Build.VERSION.SDK_INT >= 29) {
                // re-saving the same day replaces the files
                cr.delete(MediaStore.Downloads.EXTERNAL_CONTENT_URI, MediaStore.MediaColumns.RELATIVE_PATH + "=?", new String[] { rel });
            } else {
                dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Badahe/" + folder);
                dir.mkdirs();
                File[] old = dir.listFiles();
                if (old != null) for (File o : old) o.delete();
            }
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i);
                String name = f.getString("name"), src = f.getString("src");
                if (badName(name) || src.contains("..")) throw new Exception("bad name");
                try (InputStream in = new FileInputStream(new File(recDir(), src))) {
                    put(cr, dir, rel, name, "audio/mp4", in);
                }
            }
            byte[] txt = info.getString("text").getBytes(StandardCharsets.UTF_8);
            try (InputStream in = new java.io.ByteArrayInputStream(txt)) {
                put(cr, dir, rel, info.getString("name"), "text/plain", in);
            }
            JSObject r = new JSObject();
            r.put("where", "Download/Badahe/" + folder);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("save failed: " + e);
        }
    }

    private void put(ContentResolver cr, File dir, String rel, String name, String mime, InputStream in) throws Exception {
        if (dir != null) {
            File out = new File(dir, name);
            try (OutputStream o = new FileOutputStream(out)) { copy(in, o); }
            android.media.MediaScannerConnection.scanFile(getContext(), new String[] { out.getAbsolutePath() }, null, null);
            return;
        }
        ContentValues cv = new ContentValues();
        cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        cv.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
        cv.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri u = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
        if (u == null) throw new Exception("insert failed");
        try (OutputStream o = cr.openOutputStream(u)) { copy(in, o); }
        cv.clear();
        cv.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(u, cv, null, null);
    }

    private static void copy(InputStream in, OutputStream o) throws Exception {
        byte[] b = new byte[64 * 1024];
        for (int n; (n = in.read(b)) > 0; ) o.write(b, 0, n);
    }

    @PluginMethod
    public void share(PluginCall call) {
        io.execute(() -> {
            try {
                JSArray files = call.getArray("files");
                JSObject info = call.getObject("info");
                File dir = new File(getContext().getCacheDir(), "share");
                File[] old = dir.listFiles();
                if (old != null) for (File o : old) o.delete();
                dir.mkdirs();
                ArrayList<Uri> uris = new ArrayList<>();
                for (int i = 0; i < files.length(); i++) {
                    JSONObject f = files.getJSONObject(i);
                    String name = f.getString("name"), src = f.getString("src");
                    if (badName(name) || src.contains("..")) throw new Exception("bad name");
                    File out = new File(dir, name);
                    try (InputStream in = new FileInputStream(new File(recDir(), src)); OutputStream o = new FileOutputStream(out)) { copy(in, o); }
                    uris.add(uri(out));
                }
                if (badName(info.getString("name"))) throw new Exception("bad name");
                File t = new File(dir, info.getString("name"));
                try (OutputStream o = new FileOutputStream(t)) { o.write(info.getString("text").getBytes(StandardCharsets.UTF_8)); }
                uris.add(uri(t));
                Intent it = new Intent(Intent.ACTION_SEND_MULTIPLE).setType("*/*");
                it.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
                ClipData cd = ClipData.newRawUri(null, uris.get(0));
                for (int i = 1; i < uris.size(); i++) cd.addItem(new ClipData.Item(uris.get(i)));
                it.setClipData(cd);
                it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().runOnUiThread(() -> getActivity().startActivity(Intent.createChooser(it, null)));
                call.resolve();
            } catch (Exception e) {
                call.reject("share failed: " + e);
            }
        });
    }

    private Uri uri(File f) {
        return FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
    }

    /* ---------- update ---------- */

    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith(RELEASE_PREFIX)) { call.reject("bad url"); return; }
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName())));
            JSObject r = new JSObject();
            r.put("needPerm", true);
            call.resolve(r);
            return;
        }
        io.execute(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "update");
                dir.mkdirs();
                File apk = new File(dir, "badahe.apk");
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                if (c.getResponseCode() != 200) throw new Exception("http " + c.getResponseCode());
                try (InputStream in = c.getInputStream(); OutputStream o = new FileOutputStream(apk)) { copy(in, o); }
                Intent it = new Intent(Intent.ACTION_VIEW).setDataAndType(uri(apk), "application/vnd.android.package-archive");
                it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().runOnUiThread(() -> getActivity().startActivity(it));
                JSObject r = new JSObject();
                r.put("ok", true);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("download failed: " + e);
            }
        });
    }
}
