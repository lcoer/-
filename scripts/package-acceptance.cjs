// Assemble only verified, explicit delivery files; never copy a developer profile.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {execFileSync}=require('child_process');
const asar=require('@electron/asar');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
const out=path.join(root,'dist',`验收交付-${version}`);
const evidence=path.join(root,'tmp',`acceptance-${version}`);
const installer=`双鱼部落写作业机器人 Setup ${version}.exe`;
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read=name=>JSON.parse(fs.readFileSync(path.join(evidence,name),'utf8').replace(/^\uFEFF/,''));
const validation=read('delivery-validation.json');
const installerPath=path.join(root,'dist',installer);
if(validation.installerSha256!==hash(installerPath)||!validation.ok)throw Error('Final installer validation missing or stale');
const packed=path.join(root,'dist','win-unpacked','resources','app.asar');
if(JSON.parse(asar.extractFile(packed,'package.json')).version!==version)throw Error('Package version mismatch');
const bad=asar.listPackage(packed).filter(p=>/(?:^|[/\\])(?:tmp|exports|\.git|\.data|user-data)(?:[/\\]|$)|records-v\d|outcomes-v\d|recommendations-v\d|\.keystore$|\.pem$|\.env$/.test(p));
if(bad.length)throw Error('Unexpected private/development package resources: '+bad.join(','));
const smoke=read('final-smoke-result.json');
if(!smoke.ok||!smoke.checks.localFontsOffline)throw Error('Final offline UI smoke failed');
const testBytes=fs.readFileSync(path.join(evidence,'tests-final.log'));
const tests=testBytes.toString(testBytes[0]===0xff&&testBytes[1]===0xfe?'utf16le':'utf8');
const testCount=Number(/tests\s+(\d+)/.exec(tests)?.[1]),passed=Number(/pass\s+(\d+)/.exec(tests)?.[1]);
if(!/fail 0/.test(tests)||!testCount||passed!==testCount)throw Error('Full regression evidence missing');
fs.mkdirSync(out,{recursive:true});
fs.copyFileSync(installerPath,path.join(out,installer));
const write=(name,text)=>fs.writeFileSync(path.join(out,name),text.replace(/\n/g,'\r\n'),'utf8');
write('先读我-安装配置.txt',`双鱼助手 ${version}｜Windows x64 验收交付

1. 解压交付包，运行“${installer}”，选择安装目录。安装后从桌面“​​双鱼部落写作业机器人”启动。
2. 无需安装 Node.js、npm 或下载源码。程序自带 Electron 运行时、界面字体及 SYL Bridge APK。
3. 真实功能需要启动雷电模拟器，在其中安装并登录双鱼部落。模拟器和双鱼部落不包含在本交付包中。
4. 在软件“设置”点击“检测并连接模拟器”。非默认安装位置点击“手动指定 adb 路径”，选择模拟器目录中的 adb.exe。
5. 点击“安装/启用无障碍桥接”，确认显示“协议 v2 已就绪”。若未启用，请按软件提示在模拟器中启用 SYL Bridge。
6. 打开“实时贵宾位”，开始采集并观察结果，停止后数据保留。推荐列表默认财富等级≥54为高等级，明确显示问号的等级默认高等级，未识别等级单列。
7. 控制台可开启“按等级筛选”，勾选高等级或低等级，在原规则名单内进一步筛选。等级未识别排除，确认窗口显示排除数量。靓号与真实 UID 分开；待核验资料不能用于私信。
8. 私信验收前填写接收方自己的发送账号 UID，核对指定测试对象和文案，限制最多1条；不得默认认为界面确认等于服务器送达。
9. 从 Windows 已安装应用列表卸载本软件。正常卸载保留用户数据；重装可读取原记录。

数据和启动日志保存在当前 Windows 用户的应用数据目录；日志文件位于 %APPDATA%\\shuangyu-assistant\\main.log。
交付未附带原开发账号、用户资料、发送记录、本机配置、密码或密钥。首次安装有通用示例文案，请验收方自行编辑。
安装包未进行商业代码签名；受组织安装策略限制时请联系验收方IT核准，不修改系统安全设置。
通过 PowerShell 的 Get-FileHash -Algorithm SHA256 检查文件，结果应与 SHA256SUMS.txt 一致。
`);
write('验收清单.txt',`双鱼助手 ${version} 接收方验收清单

[ ] Windows 64位，安装成功，桌面快捷方式可启动，版本显示${version}。
[ ] 不安装开发环境也可打开全部7个页面；离线启动字体和图标正常。
[ ] 雷电已启动，双鱼部落已登录；非默认路径可配置；桥接协议v2就绪。
[ ] 开始采集有资料更新，停止可用，性别和等级无法确认时显示未知而非猜测。
[ ] 普通/特效资料卡能够采集可确认字段；靓号资料为待核验，不能作为真实UID发送。
[ ] 财富等级53为低、54为高；明确问号为高，缺失等级单列。
[ ] 推荐列表只展示分类与用户明细，没有用户勾选和作者分配入口；控制台的高低等级筛选可用。
[ ] 文案、规则、黑名单、等级筛选保存并重启后可读取；已有资料和分类标准保留。
[ ] 无模拟器或桥接不可用时有明确提示，不悄悄切换演示模式。
[ ] 真实私信仅在明确授权的测试账号执行1条，接收人实际确认；失败或待确认不重复发送。
[ ] 卸载成功；若需清除用户数据须另行明确操作。

记录：验收电脑系统____ 模拟器版本____ 双鱼部落版本____ 测试账号权限____ 日期____
结果：通过/不通过____ 发现问题及日志____
`);
write('测试结果与限制.txt',`双鱼助手 ${version} 交付验证

已验证：${passed}/${testCount}回归测试通过，静态检查通过，NSIS构建成功。
最终包离线界面冒烟通过：${Object.keys(smoke.checks).filter(k=>smoke.checks[k]===true).join('、')}。
实际安装、独立目录启动、正常退出、重启、卸载通过；原双鱼助手快捷方式保持不变。
安装版真实采集访问2个房间，${validation.native.records}条记录，其中软件确认UID ${validation.native.verified}条、待核验${validation.native.hints}条，重复行${validation.native.duplicateScopedRows}条；特效男性/魅力195读取通过，重启文件内容未变。
无模拟器、桥接未启用和非默认ADB路径：使用安装包代码及注入设备响应验证；未关闭用户的真实模拟器或无障碍服务。
隐私审查：打包资源不含用户资料、发送记录、配置数据库或密钥；交付只包含安装程序与本说明文件。
启动改进：字体及图标已内置，断外网条件下验证加载；业务访问双鱼部落仍需网络。

未验证：另一台干净电脑的系统兼容性、接收方账户权限及真实消息服务器送达。当前机器无 Windows Sandbox。
真实私信本轮未发送，演示检查不能作为真实送达证据。
识别仍受页面展示与平台权限影响：资料缺少真实UID或不可读字段时保留待核验/未知；成员名单不可用时降级读取公开线索，不保证完整在线名单。
安装包为未签名测试交付版本，接收方需按组织安装策略核准。
本地原始日志和采集数据未打入交付包，以免泄露个人资料。
`);
const allowed=[installer,'先读我-安装配置.txt','验收清单.txt','测试结果与限制.txt','SHA256SUMS.txt'];
const extra=fs.readdirSync(out).filter(name=>!allowed.includes(name));
if(extra.length)throw Error('Unexpected delivery files: '+extra.join(','));
write('SHA256SUMS.txt',allowed.filter(n=>n!=='SHA256SUMS.txt').map(n=>`${hash(path.join(out,n))}  ${n}`).join('\n')+'\n');
const zip=path.join(root,'dist',`双鱼助手-${version}-Windows-x64-验收包.zip`);
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Compress-Archive -LiteralPath $env:SYBL_DELIVERY_FOLDER -DestinationPath $env:SYBL_DELIVERY_ZIP -Force'],{env:{...process.env,SYBL_DELIVERY_FOLDER:out,SYBL_DELIVERY_ZIP:zip},windowsHide:true});
fs.writeFileSync(zip+'.sha256.txt',`${hash(zip)}  ${path.basename(zip)}\r\n`,'utf8');
console.log(JSON.stringify({zip,bytes:fs.statSync(zip).size,sha256:hash(zip),files:allowed},null,2));
