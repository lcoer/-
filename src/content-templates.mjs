// src/content-templates.mjs - 内容模板生成
// 职责:生成随机化消息内容,防止内容重复触发风控
//   1. 多模板随机选择
//   2. 昵称/时间/表情等随机变量插入
//   3. 模拟人类说话节奏(非完全相同句式)

const TEMPLATES = [
  '你好呀{nickname}',
  '哈喽{nickname}~',
  '{nickname}在吗',
  '嗨{nickname}',
  '在嘛{emoji}',
  '{nickname}你好',
  '嘿{nickname}{emoji}',
  '晚上好{nickname}',
  '刚看到你{nickname}',
  '{nickname}聊聊天嘛',
];

const EMOJIS = ['😊', '👋', '✨', '🌟', '💫', '🎀', '🌸', '🍀', '🎈', '🌈'];

const TIME_GREETINGS = {
  morning: ['早安', '早上好'],
  afternoon: ['午安', '下午好'],
  evening: ['晚上好', '晚安'],
};

function getCurrentTimePeriod() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}

function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randomPick(arr) { return arr[randomInt(0, arr.length - 1)]; }

export function generateMessage(nickname = '') {
  const template = randomPick(TEMPLATES);
  const emoji = randomPick(EMOJIS);
  let content = template
    .replace('{nickname}', nickname ? ` ${nickname}` : '')
    .replace('{emoji}', emoji);
  const period = getCurrentTimePeriod();
  const greeting = randomPick(TIME_GREETINGS[period]);
  content = content.replace('晚上好', greeting);
  return content;
}

export function randomDelay(minMs = 30000, maxMs = 90000) {
  return randomInt(minMs, maxMs);
}
