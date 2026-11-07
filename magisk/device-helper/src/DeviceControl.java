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

    private static Object tryInvoke(Object receiver, String name) {
        try {
            return receiver.getClass().getMethod(name).invoke(receiver);
        } catch (Exception unsupported) {
            return null;
        }
    }

    /** 读系统保存的热点配置（参照 VPNHotspot：WifiManager.getSoftApConfiguration，API 30+）。 */
    private static JSONObject systemConfig(Object wifi) throws Exception {
        Object config = invoke(wifi, "getSoftApConfiguration", new Class<?>[0]);
        JSONObject result = new JSONObject();
        if (config == null) return result;
        Object ssid = tryInvoke(config, "getSsid");
        if (ssid == null) {
            Object wifiSsid = tryInvoke(config, "getWifiSsid");
            if (wifiSsid != null) {
                String text = wifiSsid.toString();
                ssid = text.length() >= 2 && text.startsWith("\"") && text.endsWith("\"") ? text.substring(1, text.length() - 1) : text;
            }
        }
        result.put("ssid", ssid == null ? "" : ssid.toString());
        Object passphrase = tryInvoke(config, "getPassphrase");
        result.put("password", passphrase == null ? "" : passphrase.toString());
        Object security = tryInvoke(config, "getSecurityType");
        result.put("security", security == null ? -1 : (Integer) security);
        Object band = tryInvoke(config, "getBand");
        result.put("band", band == null ? 0 : (Integer) band);
        Object hidden = tryInvoke(config, "isHiddenSsid");
        result.put("hidden", Boolean.TRUE.equals(hidden));
        Object clients = tryInvoke(config, "getMaxNumberOfClients");
        result.put("max_clients", clients == null ? 0 : (Integer) clients);
        return result;
    }

    private static JSONObject status(Object wifi, Object tethering) throws Exception {
        int state = (Integer) invoke(wifi, "getWifiApState", new Class<?>[0]);
        String[] active = (String[]) invoke(tethering, "getTetheredIfaces", new Class<?>[0]);
        String[] patterns = (String[]) invoke(tethering, "getTetherableWifiRegexs", new Class<?>[0]);
        boolean tethered = false;
        org.json.JSONArray ifaces = new org.json.JSONArray();
        for (String iface : active) {
            for (String pattern : patterns) {
                if (iface.matches(pattern)) { tethered = true; ifaces.put(iface); break; }
            }
        }
        JSONObject result = new JSONObject().put("ok", true).put("state", state)
                .put("enabled", state == 13 ? Boolean.TRUE : state == 11 ? Boolean.FALSE : JSONObject.NULL)
                .put("tethered", tethered).put("ifaces", ifaces);
        try {
            result.put("config", systemConfig(wifi));
        } catch (Exception failure) {
            Throwable cause = failure instanceof InvocationTargetException && failure.getCause() != null ? failure.getCause() : failure;
            result.put("config_error", "读取系统热点配置失败：" + (cause.getMessage() == null ? cause.getClass().getSimpleName() : cause.getMessage()));
        }
        return result;
    }

    /**
     * 修改系统热点配置：在当前配置基础上只改名称、密码、加密、频段、隐藏，信道、MAC 随机化等其它设置保持不变，
     * 写入系统（WifiManager.setSoftApConfiguration），与系统设置里修改热点等效。
     */
    private static void configure(Object wifi, String path) throws Exception {
        File file = new File(path);
        if (!file.isFile() || file.length() > 4096) throw new IllegalArgumentException("热点配置缺失或过大");
        JSONObject wanted = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        SoftApConfiguration current = (SoftApConfiguration) invoke(wifi, "getSoftApConfiguration", new Class<?>[0]);
        SoftApConfiguration.Builder builder;
        try {
            builder = SoftApConfiguration.Builder.class.getConstructor(SoftApConfiguration.class).newInstance(current);
        } catch (NoSuchMethodException unsupported) {
            builder = new SoftApConfiguration.Builder();
        }
        if (wanted.has("ssid")) invoke(builder, "setSsid", new Class<?>[]{String.class}, wanted.getString("ssid"));
        if (wanted.has("security")) {
            int security = wanted.getInt("security");
            String password = wanted.optString("password", "");
            if (password.isEmpty() && security != 0) {
                Object old = tryInvoke(current, "getPassphrase");
                password = old == null ? "" : old.toString();
                if (password.isEmpty()) throw new IllegalArgumentException("加密热点需要设置密码");
            }
            invoke(builder, "setPassphrase", new Class<?>[]{String.class, int.class}, security == 0 ? null : password, security);
        }
        if (wanted.has("band")) invoke(builder, "setBand", new Class<?>[]{int.class}, wanted.getInt("band"));
        if (wanted.has("hidden")) invoke(builder, "setHiddenSsid", new Class<?>[]{boolean.class}, wanted.getBoolean("hidden"));
        SoftApConfiguration config = (SoftApConfiguration) invoke(builder, "build", new Class<?>[0]);
        boolean saved = (Boolean) invoke(wifi, "setSoftApConfiguration", new Class<?>[]{SoftApConfiguration.class}, config);
        if (!saved) throw new IllegalStateException("系统拒绝热点配置");
    }

    private static void start(Object wifi, Object tethering) throws Exception {
        // 使用系统保存的热点配置（与系统设置里打开热点一致），配置由 configure 写入系统
        Class<?> requestClass = Class.forName("android.net.TetheringManager$TetheringRequest");
        Class<?> builderClass = Class.forName("android.net.TetheringManager$TetheringRequest$Builder");
        Object builder = builderClass.getConstructor(int.class).newInstance(0);
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
        if ("config".equals(args[0]) && args.length == 2) {
            configure(wifi, args[1]);
            return status(wifi, tethering).put("saved", true);
        }
        boolean enable;
        if ("start".equals(args[0]) && args.length == 1) {
            enable = true;
            start(wifi, tethering);
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
