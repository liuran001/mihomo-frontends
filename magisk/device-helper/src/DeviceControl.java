package mihomo.device;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.res.Resources;
import android.net.wifi.SoftApConfiguration;
import android.os.Looper;
import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

public final class DeviceControl {
    private static Object invoke(Object receiver, String name, Class<?>[] types, Object... values) throws Exception {
        return receiver.getClass().getMethod(name, types).invoke(receiver, values);
    }

    private static Context context() throws Exception {
        if (Looper.getMainLooper() == null) Looper.prepareMainLooper();
        Class<?> activityThread = Class.forName("android.app.ActivityThread");
        Object thread = activityThread.getMethod("systemMain").invoke(null);
        // systemMain 不会初始化 Mainline 模块（蓝牙等）的 ServiceManager，不补上的话 BluetoothManager.getAdapter() 为 null
        try {
            activityThread.getMethod("initializeMainlineModules").invoke(null);
        } catch (Exception unsupported) {
            // 旧系统没有这个方法，或已初始化过
        }
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

    // 网络共享类型：TetheringManager.TETHERING_WIFI / USB / BLUETOOTH
    private static final String[] TYPES = {"wifi", "usb", "bluetooth"};

    private static int typeCode(String type) {
        switch (type) {
            case "wifi": return 0;
            case "usb": return 1;
            case "bluetooth": return 2;
            default: throw new IllegalArgumentException("不支持的共享类型：" + type);
        }
    }

    private static String[] typeRegexs(Context context, Object tethering, String type) {
        String method = "wifi".equals(type) ? "getTetherableWifiRegexs" : "usb".equals(type) ? "getTetherableUsbRegexs" : "getTetherableBluetoothRegexs";
        List<String> patterns = new ArrayList<>();
        try {
            String[] found = (String[]) invoke(tethering, method, new Class<?>[0]);
            if (found != null) Collections.addAll(patterns, found);
        } catch (Exception unsupported) {
            // 没有这个接口时按不支持处理
        }
        // USB 共享走 NCM 时网卡叫 ncm0 等，只写在 config_tether_ncm_regexs 里（参照 VPNHotspot 的 TetherType：NCM 也算 USB）
        if ("usb".equals(type)) {
            for (String pattern : tetheringResourceArray(context, "config_tether_ncm_regexs")) {
                if (!patterns.contains(pattern)) patterns.add(pattern);
            }
        }
        return patterns.toArray(new String[0]);
    }

    /** 读网络共享模块（Android 11+ 为 Mainline 模块 com.android.networkstack.tethering）资源里的字符串数组；读不到返回空。 */
    private static String[] tetheringResourceArray(Context context, String name) {
        try {
            PackageManager pm = context.getPackageManager();
            for (String action : new String[]{"android.net.ITetheringConnector.InProcess", "android.net.ITetheringConnector"}) {
                List<ResolveInfo> found = pm.queryIntentServices(new Intent(action), PackageManager.MATCH_SYSTEM_ONLY);
                if (found == null || found.isEmpty()) continue;
                ApplicationInfo app = found.get(0).serviceInfo.applicationInfo;
                Resources res = pm.getResourcesForApplication(app);
                int id = res.getIdentifier(name, "array", "com.android.networkstack.tethering");
                if (id == 0) id = res.getIdentifier(name, "array", app.packageName);
                if (id == 0) return new String[0];
                String[] values = res.getStringArray(id);
                return values == null ? new String[0] : values;
            }
        } catch (Exception unsupported) {
            // 读不到就只用 TetheringManager 给的正则
        }
        return new String[0];
    }

    /** app_process 里没有 Application，BluetoothAdapter.getDefaultAdapter() 会返回 null，要从 Context 取。 */
    private static BluetoothAdapter bluetoothAdapter(Context context) {
        try {
            BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
            return manager == null ? null : manager.getAdapter();
        } catch (Exception unsupported) {
            return null;
        }
    }

    private static final int BLUETOOTH_PAN = 5;

    /**
     * 蓝牙共享是否开启。蓝牙共享开着但还没有设备连上时没有 bt-pan 网卡，不能看网卡，
     * 要问蓝牙 PAN 服务（与系统设置 TetherSettings、VPNHotspot 相同：BluetoothPan.isTetheringOn）。
     * 拿不到 PAN 服务时返回 null，由调用方退回按网卡判断。
     */
    private static Boolean bluetoothTetheringOn(Context context, BluetoothAdapter adapter) {
        if (adapter.getState() != BluetoothAdapter.STATE_ON) return false;
        CountDownLatch connected = new CountDownLatch(1);
        AtomicReference<BluetoothProfile> pan = new AtomicReference<>();
        BluetoothProfile.ServiceListener listener = new BluetoothProfile.ServiceListener() {
            @Override public void onServiceConnected(int profile, BluetoothProfile proxy) { pan.set(proxy); connected.countDown(); }
            @Override public void onServiceDisconnected(int profile) { }
        };
        try {
            if (!adapter.getProfileProxy(context, listener, BLUETOOTH_PAN)) return null;
            // 回调投递到主线程，主线程在 main() 里跑 Looper
            if (!connected.await(3, TimeUnit.SECONDS)) return null;
            return Boolean.TRUE.equals(pan.get().getClass().getMethod("isTetheringOn").invoke(pan.get()));
        } catch (Exception unsupported) {
            return null;
        } finally {
            BluetoothProfile proxy = pan.get();
            if (proxy != null) {
                try { adapter.closeProfileProxy(BLUETOOTH_PAN, proxy); } catch (Exception ignored) { }
            }
        }
    }

    private static String tetherError(int code) {
        switch (code) {
            case 2: return "网络共享服务不可用";
            case 3: return "本机不支持这种共享";
            case 4: return "共享网卡不可用（USB 共享需先连接数据线）";
            case 11: case 13: return "运营商不允许网络共享";
            case 14: case 15: return "没有网络共享权限";
            case 16: case 17: return "本机不支持这种共享";
            case 18: return "上一次开启请求还在进行（USB 共享需先连接数据线）";
            default: return "系统拒绝网络共享，错误码 " + code;
        }
    }

    /** 各种网络共享（Wi-Fi 热点、USB、蓝牙）的状态：是否支持、是否开启、正在共享的网卡。 */
    private static JSONObject tetherStatus(Context context, Object wifi, Object tethering) throws Exception {
        String[] active = (String[]) invoke(tethering, "getTetheredIfaces", new Class<?>[0]);
        JSONObject result = new JSONObject().put("ok", true);
        for (String type : TYPES) {
            String[] patterns = typeRegexs(context, tethering, type);
            org.json.JSONArray ifaces = new org.json.JSONArray();
            for (String iface : active) {
                for (String pattern : patterns) {
                    if (iface.matches(pattern)) { ifaces.put(iface); break; }
                }
            }
            JSONObject item = new JSONObject().put("supported", patterns.length > 0).put("active", ifaces.length() > 0).put("ifaces", ifaces);
            if ("wifi".equals(type)) {
                int state = (Integer) invoke(wifi, "getWifiApState", new Class<?>[0]);
                // 热点开着但还没有网卡进入共享（启动中）也算开启
                item.put("state", state).put("active", state == 13 || ifaces.length() > 0).put("pending", state == 12 || state == 10);
            }
            if ("bluetooth".equals(type)) {
                BluetoothAdapter adapter = bluetoothAdapter(context);
                if (adapter == null) {
                    item.put("supported", false);
                } else {
                    item.put("radio", adapter.isEnabled());
                    Boolean on = bluetoothTetheringOn(context, adapter);
                    if (on != null) item.put("active", on || ifaces.length() > 0);
                }
            }
            result.put(type, item);
        }
        return result;
    }

    /** 蓝牙共享需要先打开蓝牙；以 root 运行时可直接打开。 */
    private static void ensureBluetooth(Context context) throws Exception {
        BluetoothAdapter adapter = bluetoothAdapter(context);
        if (adapter == null) throw new UnsupportedOperationException("本机没有蓝牙");
        if (adapter.getState() == BluetoothAdapter.STATE_ON) return;
        // 以 root 调 BluetoothAdapter.enable() 会被拒（调用方 uid 与包不符），改用系统自带的 cmd
        Process enable = new ProcessBuilder("cmd", "bluetooth_manager", "enable").redirectErrorStream(true).start();
        enable.getInputStream().close();
        enable.waitFor(5, TimeUnit.SECONDS);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
        while (System.nanoTime() < deadline) {
            if (adapter.getState() == BluetoothAdapter.STATE_ON) return;
            Thread.sleep(200);
        }
        throw new IllegalStateException("无法打开蓝牙，请先手动打开蓝牙");
    }

    /** 开启或关闭一种网络共享；Wi-Fi 热点等系统确认，USB / 蓝牙在有设备接入前可能还没有共享网卡，提交成功即返回。 */
    private static JSONObject tether(Context context, Object wifi, Object tethering, String type, boolean enable) throws Exception {
        int code = typeCode(type);
        if (enable) {
            if (code == 2) ensureBluetooth(context);
            start(tethering, code);
        } else {
            invoke(tethering, "stopTethering", new Class<?>[]{int.class}, code);
        }
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(6);
        JSONObject current;
        do {
            current = tetherStatus(context, wifi, tethering);
            JSONObject item = current.getJSONObject(type);
            boolean done = code == 0 ? (enable ? item.optInt("state") == 13 : item.optInt("state") == 11) : item.optBoolean("active") == enable;
            if (done) return current.put("submitted", true);
            Thread.sleep(200);
        } while (System.nanoTime() < deadline);
        if (code == 0) throw new IllegalStateException("系统尚未确认热点状态，请稍后刷新");
        return current.put("submitted", true).put("waiting", true);
    }

    private static void start(Object wifi, Object tethering) throws Exception {
        start(tethering, 0);
    }

    private static void start(Object tethering, int type) throws Exception {
        // 使用系统保存的热点配置（与系统设置里打开热点一致），配置由 configure 写入系统
        Class<?> requestClass = Class.forName("android.net.TetheringManager$TetheringRequest");
        Class<?> builderClass = Class.forName("android.net.TetheringManager$TetheringRequest$Builder");
        int outcome = start(tethering, requestClass, builderClass, type, true);
        // 个别 ROM 不允许跳过检查（TETHER_ERROR_NO_CHANGE_TETHERING_PERMISSION），按系统设置的方式再试一次
        if (outcome == 14) outcome = start(tethering, requestClass, builderClass, type, false);
        if (outcome != 0) throw new IllegalStateException(tetherError(outcome));
    }

    /**
     * 发起一次 startTethering，返回 0 或 TETHER_ERROR_*。
     * exempt：跳过运营商的共享授权检查（同 VPNHotspot，需要 TETHER_PRIVILEGED，本程序以 root 运行）；
     * 后台进程没有界面，不弹运营商授权界面。
     */
    private static int start(Object tethering, Class<?> requestClass, Class<?> builderClass, int type, boolean exempt) throws Exception {
        Object builder = builderClass.getConstructor(int.class).newInstance(type);
        if (exempt) {
            try {
                builderClass.getMethod("setExemptFromEntitlementCheck", boolean.class).invoke(builder, true);
            } catch (NoSuchMethodException unsupported) {
                // 没有这个接口就按普通请求
            }
        }
        try {
            builderClass.getMethod("setShouldShowEntitlementUi", boolean.class).invoke(builder, false);
        } catch (NoSuchMethodException unsupported) {
            // 同上
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
        if (!complete.await(12, TimeUnit.SECONDS)) throw new IllegalStateException("系统网络共享启动回调超时");
        return outcome.get();
    }

    private static JSONObject run(Context context, String[] args) throws Exception {
        if (args.length < 1) throw new IllegalArgumentException("缺少操作");
        Object wifi = context.getSystemService(Context.WIFI_SERVICE);
        Object tethering = context.getSystemService("tethering");
        if (wifi == null || tethering == null) throw new UnsupportedOperationException("ROM 未提供热点管理服务");
        if ("status".equals(args[0])) return status(wifi, tethering);
        if ("tether-status".equals(args[0]) && args.length == 1) return tetherStatus(context, wifi, tethering);
        if (("tether-start".equals(args[0]) || "tether-stop".equals(args[0])) && args.length == 2) {
            return tether(context, wifi, tethering, args[1], "tether-start".equals(args[0]));
        }
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

    /**
     * 主线程建好系统 Context 后跑 Looper：蓝牙 PAN 等服务的回调投递到主线程；
     * 实际操作放在工作线程，做完由工作线程输出结果并退出进程。
     */
    public static void main(String[] args) {
        Context context;
        try {
            context = context();
        } catch (Throwable failure) {
            finish(failure, null);
            return;
        }
        Thread worker = new Thread(() -> {
            JSONObject result;
            try {
                result = run(context, args);
            } catch (Throwable failure) {
                finish(failure, null);
                return;
            }
            finish(null, result);
        }, "mihomo-device-control");
        worker.setDaemon(true);
        worker.start();
        Looper.loop();
    }

    private static void finish(Throwable failure, JSONObject result) {
        int exit = 0;
        if (result != null) {
            System.out.println(result);
        } else {
            while (failure instanceof InvocationTargetException && failure.getCause() != null) failure = failure.getCause();
            try {
                String message = failure.getMessage();
                System.out.println(new JSONObject().put("ok", false).put("error", "ROM 不支持或系统拒绝：" + (message == null ? failure.getClass().getSimpleName() : message)));
            } catch (Exception encoding) {
                System.out.println("{\"ok\":false,\"error\":\"热点操作失败\"}");
            }
            exit = 1;
        }
        System.exit(exit);
    }
}
