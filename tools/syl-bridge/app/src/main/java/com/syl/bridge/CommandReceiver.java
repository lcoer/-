package com.syl.bridge;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.util.Arrays;
import java.util.Comparator;

/** Protocol v2: validated request IDs, private per-request files, atomic publication. */
public class CommandReceiver extends BroadcastReceiver {
    public static final int PROTOCOL_VERSION = 2;
    @Override public void onReceive(Context context, Intent intent) {
        if (!SylAccessibilityService.ACTION_CMD.equals(intent.getAction())) return;
        String requestId = intent.getStringExtra("requestId");
        if (requestId == null || !requestId.matches("[a-zA-Z0-9_-]{1,80}")) return;
        File dir = context.getFilesDir();
        if (!dir.exists()) dir.mkdirs();
        try {
            JSONObject result;
            SylAccessibilityService svc = SylAccessibilityService.get();
            if (intent.getIntExtra("protocolVersion", 0) != PROTOCOL_VERSION) {
                result = new JSONObject().put("ok", false).put("error", "PROTOCOL_MISMATCH");
            } else if ("ping".equals(intent.getStringExtra("cmd"))) {
                result = new JSONObject().put("ok", true).put("connected", svc != null);
            } else if (svc == null) {
                result = new JSONObject().put("ok", false).put("error", "SERVICE_NOT_CONNECTED");
            } else {
                File dump = new File(dir, "dump-" + requestId + ".json");
                result = new JSONObject(svc.handle(intent.getStringExtra("cmd"), intent.getStringExtra("id"),
                    intent.getStringExtra("value"), intent.getIntExtra("x", 0), intent.getIntExtra("y", 0), dump.getAbsolutePath(), requestId));
            }
            result.put("requestId", requestId).put("protocolVersion", PROTOCOL_VERSION);
            writeAtomic(new File(dir, "result-" + requestId + ".json"), result.toString());
            prune(dir);
        } catch (Exception e) { Log.e("SYLBridge", "Request failed", e); }
    }
    static boolean writeAtomic(File file, String content) {
        File temp = new File(file.getAbsolutePath() + ".tmp");
        try {
            try (FileOutputStream stream = new FileOutputStream(temp)) {
                stream.write(content.getBytes("UTF-8")); stream.flush(); stream.getFD().sync();
            }
            if (!temp.renameTo(file)) throw new java.io.IOException("atomic rename failed");
            return true;
        } catch(Exception e) { temp.delete(); Log.e("SYLBridge", "Write failed", e); return false; }
    }
    private static void prune(File dir) {
        File[] entries = dir.listFiles();
        if(entries == null) return;
        java.util.ArrayList<File> files = new java.util.ArrayList<File>();
        for(File file : entries) {
            if(file.getName().matches("(result|dump)-[a-zA-Z0-9_-]{1,80}\\.json")) files.add(file);
        }
        while(files.size() > 128) {
            File oldest = files.get(0);
            for(File file : files) if(file.lastModified() < oldest.lastModified()) oldest = file;
            oldest.delete(); files.remove(oldest);
        }
    }
}
