package com.syl.bridge;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;

/**
 * 接收 adb 广播指令并转发给无障碍服务。
 * 若服务未连接,会把错误结果写回指定文件(便于主机侧轮询)。
 */
public class CommandReceiver extends BroadcastReceiver {

    private static final String TAG = "SYLBridge";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (!SylAccessibilityService.ACTION_CMD.equals(action)) return;

        String cmd = intent.getStringExtra("cmd");
        String id = intent.getStringExtra("id");
        String value = intent.getStringExtra("value");
        String out = intent.getStringExtra("out");
        int x = intent.getIntExtra("x", 0);
        int y = intent.getIntExtra("y", 0);

        String result;
        SylAccessibilityService svc = SylAccessibilityService.get();
        if (svc == null) {
            result = "{\"ok\":false,\"error\":\"SERVICE_NOT_CONNECTED\"}";
        } else {
            result = svc.handle(cmd, id, value, x, y, out);
        }

        // dump 命令自己会写 out;其它命令把结果写到固定文件供主机读取
        // 路径优先用服务提供的私有目录,兜底走 context.getFilesDir()
        String dir = svc != null ? svc.getFilesDirPath() : null;
        if (dir == null) {
            java.io.File d = context.getFilesDir();
            dir = d != null ? d.getAbsolutePath() : "/data/data/com.syl.bridge/files";
        }
        String resultPath = dir + "/result.json";
        try {
            File f = new File(resultPath);
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            FileOutputStream fos = new FileOutputStream(f, false);
            fos.write(result.getBytes("UTF-8"));
            fos.flush();
            fos.close();
        } catch (Exception e) {
            Log.e(TAG, "写结果失败 " + resultPath + " : " + e.getMessage());
        }
    }
}
