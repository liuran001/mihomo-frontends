package mihomo.device;

import android.content.Context;
import android.net.wifi.SoftApConfiguration;
import android.os.Looper;
import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

public final class DeviceControl {
    private static Object invoke(Object receiver, String name, Class<?>[] types, Object... values) throws Exception {
        return receiver.getClass().getMethod(name, types).invoke(receiver, values);
    }

    private static Context context() throws Exception {
        if (Looper.getMainLooper() == null) Looper.prepareMainLooper();
        Class<?> activityThread = Class.forName("android.app.ActivityThread");
        Object thread = activityThread.getMethod("systemMain").invoke(null);
        Context base = (Context) activityThread.getMethod("getSystemContext").invoke(thread);
        return base.createPackageContext("com.android.shell", 0);
    }

    private static JSONObject status(Object wifi, Object tethering) throws Exception {
        int state = (Integer) invoke(wifi, "getWifiApState", new Class<?>[0]);
        String[] active = (String[]) invoke(tethering, "getTetheredIfaces", new Class<?>[0]);
        String[] patterns = (String[]) invoke(tethering, "getTetherableWifiRegexs", new Class<?>[0]);
        boolean tethered = false;
        for (String iface : active) {
            for (String pattern : patterns) if (iface.matches(pattern)) tethered = true;
        }
        JSONObject result = new JSONObject().put("ok", true).put("state", state)
                .put("enabled", state == 13 ? Boolean.TRUE : state == 11 ? Boolean.FALSE : JSONObject.NULL)
                .put("tethered", tethered);
        return result;
    }

    private static void start(Object wifi, Object tethering, String path) throws Exception {
        File file = new File(path);
        if (!file.isFile() || file.length() > 4096) throw new IllegalArgumentException("热点配置缺失或过大");
        JSONObject stored = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        String ssid = stored.getString("ssid");
        String password = stored.getString("password");
        String band = stored.getString("band");
        int bands = "2".equals(band) ? 1 : "5".equals(band) ? 2 : "any".equals(band) ? 3 : 0;
        if (bands == 0) throw new IllegalArgumentException("热点频段无效");
        SoftApConfiguration.Builder wifiBuilder = new SoftApConfiguration.Builder();
        invoke(wifiBuilder, "setSsid", new Class<?>[]{String.class}, ssid);
        invoke(wifiBuilder, "setPassphrase", new Class<?>[]{String.class, int.class}, password, SoftApConfiguration.SECURITY_TYPE_WPA2_PSK);
        invoke(wifiBuilder, "setBand", new Class<?>[]{int.class}, bands);
        SoftApConfiguration config = wifiBuilder.build();
        Class<?> requestClass = Class.forName("android.net.TetheringManager$TetheringRequest");
        Class<?> builderClass = Class.forName("android.net.TetheringManager$TetheringRequest$Builder");
        Object builder = builderClass.getConstructor(int.class).newInstance(0);
        try {
            builderClass.getMethod("setSoftApConfiguration", SoftApConfiguration.class).invoke(builder, config);
        } catch (NoSuchMethodException unsupported) {
            boolean saved = (Boolean) invoke(wifi, "setSoftApConfiguration", new Class<?>[]{SoftApConfiguration.class}, config);
            if (!saved) throw new IllegalStateException("系统拒绝热点配置");
        }
        Object request = builderClass.getMethod("build").invoke(builder);
        CountDownLatch complete = new CountDownLatch(1);
        AtomicInteger outcome = new AtomicInteger(-1);
        Class<?> callbackClass = Class.forName("android.net.TetheringManager$StartTetheringCallback");
        Object callback = Proxy.newProxyInstance(callbackClass.getClassLoader(), new Class<?>[]{callbackClass}, (proxy, method, args) -> {
            switch (method.getName()) {
                case "onTetheringStarted": outcome.set(0); complete.countDown(); return null;
                case "onTetheringFailed": outcome.set((Integer) args[0]); complete.countDown(); return null;
                case "hashCode": return System.identityHashCode(proxy);
                case "equals": return proxy == args[0];
                case "toString": return "MihomoTetheringCallback";
                default: return null;
            }
        });
        Executor executor = Runnable::run;
        invoke(tethering, "startTethering", new Class<?>[]{requestClass, Executor.class, callbackClass}, request, executor, callback);
        if (!complete.await(12, TimeUnit.SECONDS)) throw new IllegalStateException("系统热点启动回调超时");
        if (outcome.get() != 0) throw new IllegalStateException("系统拒绝网络共享，错误码 " + outcome.get());
    }

    private static JSONObject run(String[] args) throws Exception {
        if (args.length < 1) throw new IllegalArgumentException("缺少操作");
        Context context = context();
        Object wifi = context.getSystemService(Context.WIFI_SERVICE);
        Object tethering = context.getSystemService("tethering");
        if (wifi == null || tethering == null) throw new UnsupportedOperationException("ROM 未提供热点管理服务");
        if ("status".equals(args[0])) return status(wifi, tethering);
        boolean enable;
        if ("start".equals(args[0]) && args.length == 2) {
            enable = true;
            start(wifi, tethering, args[1]);
        } else if ("stop".equals(args[0]) && args.length == 1) {
            enable = false;
            invoke(tethering, "stopTethering", new Class<?>[]{int.class}, 0);
        } else throw new IllegalArgumentException("不支持的操作");
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(6);
        do {
            JSONObject current = status(wifi, tethering);
            if (enable ? current.optBoolean("enabled") && current.optBoolean("tethered") : current.optInt("state") == 11) {
                return current.put("submitted", true);
            }
            Thread.sleep(200);
        } while (System.nanoTime() < deadline);
        throw new IllegalStateException("系统尚未确认热点和网络共享状态，请重新读取状态");
    }

    public static void main(String[] args) {
        int exit = 0;
        try {
            System.out.println(run(args));
        } catch (Throwable failure) {
            while (failure instanceof InvocationTargetException && failure.getCause() != null) failure = failure.getCause();
            try {
                String message = failure.getMessage();
                System.out.println(new JSONObject().put("ok", false).put("error", "ROM 不支持或系统拒绝热点操作：" + (message == null ? failure.getClass().getSimpleName() : message)));
            } catch (Exception encoding) {
                System.out.println("{\"ok\":false,\"error\":\"热点操作失败\"}");
            }
            exit = 1;
        }
        System.exit(exit);
    }
}
