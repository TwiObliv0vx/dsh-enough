# Changelog

## 0.2.0 — 2026-11-14

- feat(preset hook): 当前 DSH 把压缩引擎放在 agent preset 的隔离组里（`isolate: { compaction: true }`），Host 层 `ctx.get('compaction')` 是 null，`takeover` 因此一直装不上。新增 `lib/preset-hook.js`：监听全局 `internal/config`，把 `compactThresholdRatio` 写进预设的 `compaction-basic` 配置，并在同一组追加 `enough-handoff` 行。
- feat(preset handoff): 新增 `lib/preset-handoff.js`，在预设域内替换引擎的 `summarize()`；幂等，原方法保留在引擎上。
- feat(config): 新增 `presetHandoff`（默认 true）、`compactThresholdRatio`（0 = 不动引擎自己的阈值）、`handoffSpec`（覆盖插入行的模块 spec）。
- feat(status): `enough_status` 与 `/enough` 增加 `preset hook` 行（安装状态、改写计数、实际写入的阈值）。
- test: 新增 `test/hook.mjs`（20 项断言），`test/smoke.mjs` 44 项全过。
- 说明：只改隔离组内的压缩行，Host 层压缩行不动，不会重复接管；`internal/config` 是 DSH 的内部事件，失效时静默退回 coexist 并在状态里可见。

## 0.1.2 — 2026-11-14

- fix(status): report compaction-engine limits as one string (engineLimits), so the tool result is lossless JSON. Numeric fields that could be undefined were rejected by the harness before rendering.
- Bump for the schema fix; behaviour unchanged.
## 0.1.1 鈥?2026-11-14

閫氱敤鍖栦慨姝ｏ紙闈㈠悜鍏紑涓婃灦锛夛細

- 寮曟搸鍙傛暟锛坱hresholdRatio / retainRatio锛変笉鍐嶅睘浜庢湰鎻掍欢閰嶇疆锛氫粠鍘嬬缉寮曟搸瀹炴椂璇诲彇骞跺彧璇诲睍绀猴紝涓嶅啀鎸佷箙鍖栥€佷笉鍐嶅亣瑁呭彲鏀广€?- 鏂囨涓庨敊璇俊鎭幓鎺夊鐗瑰畾绗笁鏂规彃浠剁殑鐐瑰悕锛屾敼涓洪€氱敤鐨勩€屽帇缂╂湇鍔′笉鍙敤銆嶈鏄庛€?- 璁剧疆椤典笌鏂囨。涓嫳鍙岃锛堟寜娴忚鍣ㄨ瑷€閫夋嫨锛夛紱宸ュ叿鎻忚堪銆佺储寮曡緭鍑轰笌浜ゆ帴鎻愮ず璇嶆敼涓鸿嫳鏂囷紝浜ゆ帴绠€鎶ユ寜浼氳瘽璇█杈撳嚭銆?- 绉婚櫎 patch 涓庢枃妗ｉ噷鐨勬湰鏈哄畾鍒堕槇鍊肩ず渚嬨€?
## 0.1.0 鈥?2026-11-13

棣栦釜鐗堟湰銆?
- 浜ゆ帴鍘嬬缉锛圗oCC锛夛細杩愯鏃舵浛鎹㈠帇缂╁紩鎿庣殑鎽樿鍣紝杈撳嚭鍏浜ゆ帴绠€鎶ワ紙鍘熷浠诲姟 / 宸插畬鎴?/ 褰撳墠杩涘害 / 涓嬩竴姝?/ 鍏抽敭浜嬪疄 / 鏈喅闂锛夈€?- 闀胯緭鍏ラ€夋嫨鎬ц鍙栵細鏂板 `context_index` 宸ュ叿锛屾寜 Markdown 鏍囬缁欏嚭甯﹁鍙风殑鍒嗚妭绱㈠紩锛涙敮鎸佺洰褰曟壂鎻忋€?- 鍗曞姩浣滃帇缂╋紙SAC锛夛細鍙€夛紝榛樿鍏筹紝agent 绌洪棽鏃跺帇缂╀竴娆°€?- `/enough` 鍛戒护锛歴tatus / mode coexist|takeover / sac on|off / index銆?- 璁剧疆椤碉細妯″紡銆丼AC銆佹憳瑕佷笂闄愩€佺储寮曢槇鍊笺€佸紩鎿庣姸鎬併€?- 榛樿 `coexist` 妯″紡锛屼笌宸叉湁鍘嬬缉鍣ㄥ叡瀛橈紱`takeover` 杩愯鏃跺垏鎹紝鍙€嗐€?