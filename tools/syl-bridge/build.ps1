param(
    [string]$BuildTools = $env:ANDROID_BUILD_TOOLS,
    [string]$AndroidJar = $env:ANDROID_JAR,
    [string]$Jdk = $env:JAVA_HOME
)
$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$workspace = (Resolve-Path (Join-Path $project '../..')).Path
if (!$BuildTools) { $BuildTools = Join-Path $workspace 'tmp/bt/android-14' }
if (!$AndroidJar) { $AndroidJar = Join-Path $workspace 'tmp/pf33/android-13/android.jar' }
if (!$Jdk) { throw 'Set JAVA_HOME or pass -Jdk (JDK directory).' }
$output = Join-Path $project 'build'
# Resolve and check before deleting generated output.
$output = [IO.Path]::GetFullPath($output)
if ($output -ne [IO.Path]::GetFullPath((Join-Path $project 'build'))) { throw 'Invalid build output' }
foreach ($file in @((Join-Path $BuildTools 'aapt2.exe'), (Join-Path $BuildTools 'd8.bat'), (Join-Path $BuildTools 'apksigner.bat'), $AndroidJar, (Join-Path $Jdk 'bin/javac.exe'))) {
    if (!(Test-Path -LiteralPath $file)) { throw "Missing dependency: $file" }
}
function Invoke-Checked([string]$exe, [string[]]$arguments) {
     $nativeArguments = @($arguments | ForEach-Object { $v = $_.Replace('\','/'); if ($v.StartsWith($workspace.Replace('\','/') + '/')) { $v.Substring($workspace.Length + 1) } else { $v } })
    Push-Location $workspace
    try { & $exe @nativeArguments } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "$exe failed with $LASTEXITCODE" }
}
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
foreach ($sub in @('compiled','gen','classes','dex')) { New-Item -ItemType Directory -Path (Join-Path $output $sub) -Force | Out-Null }
$aapt = Join-Path $BuildTools 'aapt2.exe'
Invoke-Checked $aapt @('compile','--dir',"$project/app/src/main/res",'-o',"$output/compiled")
 $resources = @(Get-ChildItem -LiteralPath "$output/compiled" -Filter '*.flat' | ForEach-Object FullName)
Invoke-Checked $aapt (@('link','-o',"$output/base.apk",'-I',$AndroidJar,'--manifest',"$project/app/src/main/AndroidManifest.xml",'--java',"$output/gen",'--min-sdk-version','24','--target-sdk-version','33','--version-code','2','--version-name','2.0') + $resources)
$javaSources = @(Get-ChildItem -LiteralPath "$project/app/src/main/java","$output/gen" -Filter '*.java' -Recurse | ForEach-Object FullName)
Invoke-Checked (Join-Path $Jdk 'bin/javac.exe') (@('-encoding','UTF-8','-source','8','-target','8','-nowarn','-bootclasspath',$AndroidJar,'-classpath',$AndroidJar,'-d',"$output/classes") + $javaSources)
$classFiles = @(Get-ChildItem -LiteralPath "$output/classes" -Filter '*.class' -Recurse | ForEach-Object FullName)
$oldJava = $env:JAVA_HOME
try {
    $env:JAVA_HOME = $Jdk
    Invoke-Checked (Join-Path $BuildTools 'd8.bat') (@('--lib',$AndroidJar,'--min-api','24','--output',"$output/dex") + $classFiles)
    Copy-Item -LiteralPath "$output/base.apk" -Destination "$output/unsigned.apk"
    Invoke-Checked (Join-Path $Jdk 'bin/jar.exe') @('uf',"$output/unsigned.apk",'-C',"$output/dex",'classes.dex')
    Invoke-Checked (Join-Path $BuildTools 'zipalign.exe') @('-f','-p','4',"$output/unsigned.apk","$output/aligned.apk")
    $key = Join-Path $project 'debug.keystore'
    if (!(Test-Path -LiteralPath $key)) {
        Invoke-Checked (Join-Path $Jdk 'bin/keytool.exe') @('-genkeypair','-keystore',$key,'-storepass','android','-keypass','android','-alias','sylkey','-keyalg','RSA','-keysize','2048','-validity','10000','-dname','CN=SYL Bridge, OU=Dev, O=Local, L=NA, S=NA, C=CN')
    }
    Invoke-Checked (Join-Path $BuildTools 'apksigner.bat') @('sign','--ks',$key,'--ks-pass','pass:android','--key-pass','pass:android','--ks-key-alias','sylkey','--out',"$project/syl-bridge.apk","$output/aligned.apk")
    Invoke-Checked (Join-Path $BuildTools 'apksigner.bat') @('verify','--verbose','--print-certs',"$project/syl-bridge.apk")
    Invoke-Checked (Join-Path $BuildTools 'zipalign.exe') @('-c','4',"$project/syl-bridge.apk")
    Get-FileHash -LiteralPath "$project/syl-bridge.apk" -Algorithm SHA256
} finally { $env:JAVA_HOME = $oldJava }





