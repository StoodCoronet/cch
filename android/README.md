# CCH Android（WebView 壳）

手机端 v1 是一个 WebView 壳：加载 CCH web dashboard（登录、会话、transcript、Resume 全部复用）。
本目录是纯 Gradle 工程，零第三方依赖，只需要 Android 构建环境。

本文件面向 **Apple Silicon (ARM) Mac**，覆盖两种路线：

- **路线 A（推荐）**：Android Studio —— 装一个 app 全搞定
- **路线 B**：纯命令行 —— 不装 Android Studio

---

## 路线 A：Android Studio（推荐）

1. **下载安装 Android Studio**（Ladybug 或更新）：
   https://developer.android.com/studio
   直接下 Apple Chip 版本（`.dmg` 里标注 Mac with Apple chip）。它自带 JDK 17（JBR）、SDK Manager、模拟器。

2. **首次启动向导**里安装 SDK（默认选项即可，会装最新 Platform + build-tools + emulator）。

3. **打开项目**：`Open` → 选择本目录（`android/`）。第一次打开 Studio 会自动生成 gradle wrapper 并 sync（右下等它跑完，第一次要下载 gradle 和依赖，约几分钟）。

4. **创建模拟器**（ARM64 镜像在 M 系 Mac 上原生跑，很快）：
   `Tools → Device Manager → Create Device` → 选 `Pixel 7` → system image 选 **API 34 arm64-v8a**（没有就点 Download）→ Finish。

5. **跑起来**：选中刚建的模拟器 → 点 Run ▶。
   app 首次启动会问服务器地址。**模拟器里填 `http://10.0.2.2:3005`**（10.0.2.2 是模拟器对宿主机 localhost 的别名）。
   真机调试：手机开开发者模式 + USB 调试，插上 Mac，Run 选你的手机。服务器地址填 **Mac 的局域网 IP**（如 `http://192.168.1.106:3005`，手机要和 Mac 同一 Wi-Fi）。

6. **出 APK**：`Build → Build App Bundle(s)/APK(s) → Build APK(s)`，产物在
   `app/build/outputs/apk/debug/app-debug.apk`。

## 路线 B：纯命令行

```bash
# 1. JDK 17 + Android 命令行工具
brew install --cask temurin@17
brew install --cask android-commandlinetools

# 2. 环境变量（写进 ~/.zshrc）
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

# 3. 接受协议 + 装 SDK 组件（ARM64 镜像）
sdkmanager --licenses   # 一路 y
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0" \
           "emulator" "system-images;android-34;google_apis;arm64-v8a"

# 4. 生成 gradle wrapper（首次需要本机 gradle 一次性生成）
brew install gradle
cd android && gradle wrapper --gradle-version 8.7

# 5. 编译 APK
./gradlew assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk

# 6. 创建并启动模拟器（可选，也可以 adb 装到真机）
avdmanager create avd -n cch -k "system-images;android-34;google_apis;arm64-v8a" --device "pixel_7"
emulator -avd cch &

# 7. 安装到已连接的设备/模拟器
adb install app/build/outputs/apk/debug/app-debug.apk
```

## 服务器侧注意事项

- server 必须监听 `0.0.0.0`（我们的启动命令已带 `HOST=0.0.0.0`）。
- 模拟器访问宿主机：`http://10.0.2.2:3005`。
- 真机访问：`http://<Mac局域网IP>:3005`（`ipconfig getifaddr en0` 查看），同一 Wi-Fi。
- Mac 防火墙如果弹"是否允许 node 接受传入连接"，点允许。
- 首次登录用 web 账号（dev 环境：`test / test123`）。app 菜单里可随时改服务器地址和刷新。

## 后续路线（v2 再考虑）

- 原生体验（推送通知、后台保活、分享接收）：评估 React Native 或改 PWA + TWA。
- `app/` 目录的 Expo Happy 客户端是另一套加密协议的实现，与当前 dashboard 不兼容，暂不复用。
