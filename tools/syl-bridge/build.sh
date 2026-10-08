#!/usr/bin/env bash
# 手工编译 syl-bridge APK(无需 Android Studio / Gradle)
#
# 依赖:Android build-tools(aapt2 / d8 / apksigner)+ platform 的 android.jar
# 用法:bash build.sh
set -e

PROJ="D:/Damn/shuangyu-assistant/tools/syl-bridge"
BT="D:/Damn/shuangyu-assistant/tmp/bt/android-14"
ANDROID_JAR="D:/Damn/shuangyu-assistant/tmp/pf33/android-13/android.jar"
OUT="$PROJ/build"
JAVAC="D:/Java/jdk-25.0.2/bin/javac.exe"
KEYTOOL="D:/Java/jdk-25.0.2/bin/keytool.exe"

AAPT2="$BT/aapt2.exe"
D8="$BT/d8.bat"
APKSIGNER="$BT/apksigner.bat"
ZIPALIGN="$BT/zipalign.exe"

echo "=== 0. 检查依赖 ==="
for f in "$AAPT2" "$ANDROID_JAR" "$JAVAC"; do
  [ -f "$f" ] || { echo "缺少: $f"; exit 1; }
done
echo "OK"

echo "=== 1. 清理 ==="
rm -rf "$OUT"
mkdir -p "$OUT/compiled" "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "=== 2. aapt2 compile 资源 ==="
"$AAPT2" compile --dir "$PROJ/app/src/main/res" -o "$OUT/compiled/res.zip"

echo "=== 3. aapt2 link(生成 R.java + 基础 APK) ==="
"$AAPT2" link \
  -o "$OUT/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$PROJ/app/src/main/AndroidManifest.xml" \
  --java "$OUT/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 33 \
  --version-code 1 --version-name "1.0" \
  "$OUT/compiled/res.zip"

echo "=== 4. javac 编译 Java ==="
"$JAVAC" -encoding UTF-8 -source 8 -target 8 -nowarn \
  -bootclasspath "$ANDROID_JAR" -classpath "$ANDROID_JAR" \
  -d "$OUT/classes" \
  $(find "$PROJ/app/src/main/java" -name "*.java") \
  $(find "$OUT/gen" -name "*.java")

echo "=== 5. d8 转 dex ==="
cd "$OUT/classes"
"$D8" --lib "$ANDROID_JAR" --min-api 24 --output "$OUT/dex" $(find . -name "*.class")

echo "=== 6. 组装 APK(把 dex 塞进 base.apk) ==="
cd "$OUT/dex"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
# 用 jar 更新(classes.dex 必须在根目录)
"D:/Java/jdk-25.0.2/bin/jar.exe" uf "$OUT/unsigned.apk" classes.dex

echo "=== 7. zipalign ==="
"$ZIPALIGN" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "=== 8. 生成调试签名并签名 ==="
if [ ! -f "$PROJ/debug.keystore" ]; then
  "$KEYTOOL" -genkeypair -v -keystore "$PROJ/debug.keystore" \
    -storepass android -keypass android -alias sylkey \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=SYL Bridge, OU=Dev, O=Local, L=NA, S=NA, C=CN"
fi
"$APKSIGNER" sign --ks "$PROJ/debug.keystore" --ks-pass pass:android \
  --key-pass pass:android --ks-key-alias sylkey \
  --out "$PROJ/syl-bridge.apk" "$OUT/aligned.apk"

echo ""
echo "=== 完成 ==="
ls -la "$PROJ/syl-bridge.apk"
