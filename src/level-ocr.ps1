param([string]$InputPath,[int]$X,[int]$Y,[int]$Width,[int]$Height)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
function Await($Operation,$Type) {
 $method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
 $task=$method.MakeGenericMethod($Type).Invoke($null,@($Operation)); $task.GetAwaiter().GetResult()
}
$source=[System.Drawing.Bitmap]::FromFile($InputPath)
$crop=$source.Clone([System.Drawing.Rectangle]::new($X,$Y,$Width,$Height),[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
for($cy=0;$cy -lt $crop.Height;$cy++){for($cx=0;$cx -lt $crop.Width;$cx++){$c=$crop.GetPixel($cx,$cy);$white=$c.R -gt 225 -and $c.G -gt 225 -and $c.B -gt 225;$crop.SetPixel($cx,$cy,$(if($white){[System.Drawing.Color]::Black}else{[System.Drawing.Color]::White}))}}
$large=[System.Drawing.Bitmap]::new($crop.Width*3,$crop.Height*3);$g=[System.Drawing.Graphics]::FromImage($large);$g.DrawImage($crop,0,0,$large.Width,$large.Height);$g.Dispose();$crop.Dispose();$crop=$large;
$cropPath=$InputPath+'.crop.png';$crop.Save($cropPath,[System.Drawing.Imaging.ImageFormat]::Png);$crop.Dispose();$source.Dispose()
$file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($cropPath)) ([Windows.Storage.StorageFile])
$stream=Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap=Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime] | Out-Null
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US'))
if($null -eq $engine){$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()}
if($null -eq $engine){throw 'WINDOWS_OCR_UNAVAILABLE'}
$result=Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
@{text=$result.Text;words=@($result.Lines | ForEach-Object {$_.Words} | ForEach-Object {@{text=$_.Text;x=$_.BoundingRect.X;y=$_.BoundingRect.Y;width=$_.BoundingRect.Width;height=$_.BoundingRect.Height}})} | ConvertTo-Json -Compress -Depth 4
$bitmap.Dispose();$stream.Dispose()
