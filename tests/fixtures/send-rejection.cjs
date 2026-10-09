const n = (shortId, text, x, y, x2, y2, extra = {}) => ({ shortId, text, x, y, x2, y2, packageName: 'com.sybl.voiceroom', ...extra });
const rejectedRow = (text = 'hello') => [
  n('rc_message_list', '', 0, 326, 1080, 648),
  n('', '', 0, 326, 1080, 648, { className: 'android.widget.LinearLayout' }),
  n('rc_text', text, 345, 442, 858, 547),
  n('rc_right_portrait', '', 907, 442, 1022, 557),
  n('rc_errorhint', '您当前的贡献等级不够，快去直播看看吧。', 0, 571, 1080, 619),
];
exports.n = n;
exports.rejectedRow = rejectedRow;
