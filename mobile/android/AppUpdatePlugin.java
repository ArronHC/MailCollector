package com.openspace.mailcollector;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {
    private static final Pattern VERSION = Pattern.compile("^[0-9]+\\.[0-9]+\\.[0-9]+$");
    private static final Pattern SHA256 = Pattern.compile("(?i)\\b[a-f0-9]{64}\\b");
    private static final int MAX_REDIRECTS = 6;
    private static final int MAX_CHECKSUM_BYTES = 4096;

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String version = call.getString("version", "");
        if (!VERSION.matcher(version).matches()) {
            call.reject("更新版本号无效");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName())
            );
            getActivity().startActivity(settings);
            call.reject("请先允许 Mail Collector 安装应用更新，然后返回并再次点击更新");
            return;
        }

        new Thread(() -> {
            try {
                File updateDirectory = new File(getContext().getCacheDir(), "updates");
                if (!updateDirectory.exists() && !updateDirectory.mkdirs()) {
                    throw new IllegalStateException("无法创建更新缓存目录");
                }

                String name = "MailCollector-Android-v" + version + ".apk";
                String baseUrl = "https://github.com/ArronHC/MailCollector/releases/download/v" + version + "/";
                String expected = fetchChecksum(baseUrl + name + ".sha256");
                File temporary = new File(updateDirectory, name + ".download");
                File apk = new File(updateDirectory, name);

                downloadFile(baseUrl + name, temporary);
                String actual = sha256(temporary);
                if (!actual.equals(expected)) {
                    temporary.delete();
                    throw new SecurityException("更新包 SHA-256 校验失败");
                }
                if (apk.exists() && !apk.delete()) {
                    throw new IllegalStateException("无法替换旧的更新缓存");
                }
                if (!temporary.renameTo(apk)) {
                    throw new IllegalStateException("无法准备更新安装包");
                }

                getActivity().runOnUiThread(() -> {
                    try {
                        Uri uri = FileProvider.getUriForFile(
                                getContext(),
                                getContext().getPackageName() + ".fileprovider",
                                apk
                        );
                        Intent install = new Intent(Intent.ACTION_VIEW);
                        install.setDataAndType(uri, "application/vnd.android.package-archive");
                        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                        getActivity().startActivity(install);
                        JSObject result = new JSObject();
                        result.put("started", true);
                        call.resolve(result);
                    } catch (Exception error) {
                        call.reject("无法打开 Android 系统安装界面", error);
                    }
                });
            } catch (Exception error) {
                call.reject("下载或校验更新失败：" + error.getMessage(), error);
            }
        }, "mailcollector-app-update").start();
    }

    private static String fetchChecksum(String url) throws Exception {
        byte[] bytes = downloadBytes(url, MAX_CHECKSUM_BYTES);
        Matcher matcher = SHA256.matcher(new String(bytes, java.nio.charset.StandardCharsets.US_ASCII));
        if (!matcher.find()) throw new SecurityException("更新校验文件无效");
        return matcher.group().toLowerCase(Locale.ROOT);
    }

    private static byte[] downloadBytes(String url, int limit) throws Exception {
        HttpURLConnection connection = open(url);
        try (InputStream input = new BufferedInputStream(connection.getInputStream());
             java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024];
            int total = 0;
            int count;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > limit) throw new SecurityException("更新校验文件过大");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        } finally {
            connection.disconnect();
        }
    }

    private static void downloadFile(String url, File target) throws Exception {
        HttpURLConnection connection = open(url);
        try (InputStream input = new BufferedInputStream(connection.getInputStream());
             FileOutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        } catch (Exception error) {
            target.delete();
            throw error;
        } finally {
            connection.disconnect();
        }
    }

    private static HttpURLConnection open(String input) throws Exception {
        URL url = new URL(input);
        for (int redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(60_000);
            connection.setRequestProperty("Accept", "application/octet-stream");
            connection.setRequestProperty("User-Agent", "MailCollector-Android-Updater");
            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) return connection;
            if (status < 300 || status >= 400 || connection.getHeaderField("Location") == null) {
                connection.disconnect();
                throw new IllegalStateException("更新服务器返回 HTTP " + status);
            }
            URL next = new URL(url, connection.getHeaderField("Location"));
            connection.disconnect();
            if (!"https".equalsIgnoreCase(next.getProtocol())) {
                throw new SecurityException("拒绝不安全的更新下载地址");
            }
            url = next;
        }
        throw new IllegalStateException("更新下载重定向次数过多");
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        StringBuilder output = new StringBuilder(64);
        for (byte value : digest.digest()) output.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return output.toString();
    }
}
