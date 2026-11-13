/**
 * dsh-enough — client half.
 *
 * A single settings section ("够用" / dsh-enough) with the knobs that are safe
 * to change at runtime:
 *
 *   - mode: coexist (tools only) ⇄ takeover (handoff summarizer)
 *   - SAC: compact once whenever an agent goes idle (off by default)
 *   - summaryMaxTokens: cap for the handoff brief
 *   - indexMinBytes / indexMaxFiles: what context_index treats as "big"
 *
 * thresholdRatio / retainRatio belong to @deepseek-ai/dsh-compaction-basic and
 * are frozen on its config at startup, so they are shown read-only here; set
 * them in the profile's cordis.patch.yml if you need different values.
 *
 * Plain browser JS on purpose: `window.__ModuleLoader__.load` + React's
 * createElement, no bundler, same shape as the other small DSH plugins.
 */

window.__ModuleLoader__.load({
  id: "dsh-enough",
  factory: (require, module, exports) => {
    const exp = exports ?? (module ? module.exports : undefined) ?? {};
    const React = require("react");
    const { createElement: h, useCallback, useEffect, useState } = React;

    const API = "/enough/api";
    const SECTION_ID = "dsh-enough";

    const C = {
      text: "inherit",
      muted: "rgba(127,127,127,.85)",
      border: "rgba(127,127,127,.28)",
      bg: "rgba(127,127,127,.06)",
      accent: "#4090ff",
      ok: "#2e9e5b",
      bad: "#c94f45",
    };

    const rowStyle = {
      display: "flex",
      alignItems: "flex-start",
      gap: 12,
      padding: "10px 0",
      borderBottom: `1px solid ${C.border}`,
    };
    const labelStyle = { width: 148, flex: "0 0 148px", fontSize: 13, paddingTop: 3 };
    const bodyStyle = { flex: "1 1 auto", minWidth: 0 };
    const hintStyle = { fontSize: 12, color: C.muted, marginTop: 4, lineHeight: 1.5 };
    const inputStyle = {
      width: 110,
      padding: "4px 8px",
      fontSize: 13,
      color: C.text,
      background: C.bg,
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      outline: "none",
    };
    const btnStyle = {
      padding: "6px 14px",
      fontSize: 13,
      color: "#fff",
      background: C.accent,
      border: "none",
      borderRadius: 6,
      cursor: "pointer",
    };
    const btnGhostStyle = {
      ...btnStyle,
      color: C.text,
      background: "transparent",
      border: `1px solid ${C.border}`,
      cursor: "pointer",
    };

    async function getJson(path) {
      const res = await fetch(`${API}${path}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    async function postJson(path, body) {
      const res = await fetch(`${API}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    function Field(props) {
      const { label, hint, children } = props;
      return h(
        "div",
        { style: rowStyle },
        h("div", { style: labelStyle }, label),
        h(
          "div",
          { style: bodyStyle },
          children,
          hint ? h("div", { style: hintStyle }, hint) : null,
        ),
      );
    }

    function EnoughSection() {
      const [cfg, setCfg] = useState(null);
      const [form, setForm] = useState(null);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState(null);
      const [error, setError] = useState(null);

      const apply = useCallback((j) => {
        if (!j?.ok) return;
        setCfg(j.config);
        setForm({
          mode: j.config.mode,
          sac: j.config.sac,
          summaryMaxTokens: j.config.summaryMaxTokens,
          indexMinBytes: j.config.indexMinBytes,
          indexMaxFiles: j.config.indexMaxFiles,
        });
        setError(null);
      }, []);

      const load = useCallback(async () => {
        try {
          apply(await getJson("/config"));
        } catch (e) {
          setError(`读取配置失败：${e?.message ?? e}`);
        }
      }, [apply]);

      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const j = await getJson("/config");
            if (alive) apply(j);
          } catch (e) {
            if (alive) setError(`读取配置失败：${e?.message ?? e}`);
          }
        })();
        return () => {
          alive = false;
        };
      }, [apply]);

      const set = useCallback((key, value) => {
        setForm((f) => (f ? { ...f, [key]: value } : f));
        setMsg(null);
      }, []);

      const save = useCallback(async () => {
        if (!form || busy) return;
        setBusy(true);
        setMsg(null);
        try {
          apply(
            await postJson("/config", {
              mode: form.mode,
              sac: !!form.sac,
              summaryMaxTokens: Number(form.summaryMaxTokens),
              indexMinBytes: Number(form.indexMinBytes),
              indexMaxFiles: Number(form.indexMaxFiles),
            }),
          );
          setMsg("已保存");
        } catch (e) {
          setError(`保存失败：${e?.message ?? e}`);
        } finally {
          setBusy(false);
        }
      }, [form, busy, apply]);

      if (!cfg || !form) {
        return h(
          "div",
          { style: { padding: 16, fontSize: 13, color: C.muted } },
          error ?? "读取中…",
        );
      }

      return h(
        "div",
        { style: { padding: "4px 0 18px" } },
        h(
          "div",
          { style: { fontSize: 15, fontWeight: 600, marginBottom: 2 } },
          "够用 · dsh-enough",
        ),
        h(
          "div",
          { style: { ...hintStyle, marginBottom: 10 } },
          "You don't need long context. 上下文到阈值时，把旧历史换成一个「谁接手都能继续」的交接简报；长文档先建索引再按需读。",
        ),

        h(
          Field,
          { label: "模式", hint: form.mode === "takeover" ? "接管：压缩时用交接简报替换旧历史（运行时生效，可随时切回）。" : "共存：只提供 context_index 与 /enough 命令，不动现有压缩（billion-context 可继续工作）。" },
          h(
            "div",
            { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
            [
              ["coexist", "共存（默认）"],
              ["takeover", "接管"],
            ].map(([value, label]) =>
              h(
                "button",
                {
                  key: value,
                  type: "button",
                  style: form.mode === value ? btnStyle : btnGhostStyle,
                  onClick: () => set("mode", value),
                },
                label,
              ),
            ),
          ),
        ),

        h(
          Field,
          { label: "单动作压缩", hint: "SAC：每次 agent 空闲就压一次，只留语义状态。默认关，适合长任务密集执行。" },
          h(
            "label",
            { style: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13 } },
            h("input", {
              type: "checkbox",
              checked: !!form.sac,
              onChange: (e) => set("sac", e.target.checked),
            }),
            form.sac ? "开" : "关",
          ),
        ),

        h(
          Field,
          { label: "摘要上限", hint: "交接简报最多多少 token。越大保留越多细节，也越占上下文。" },
          h("input", {
            type: "number",
            min: 256,
            step: 256,
            style: inputStyle,
            value: form.summaryMaxTokens,
            onChange: (e) => set("summaryMaxTokens", e.target.value),
          }),
        ),

        h(
          Field,
          {
            label: "索引阈值",
            hint: "context_index 把多大的文件当「长文档」：文件字节下限 / 目录最多列多少个。",
          },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
            h("input", {
              type: "number",
              min: 0,
              step: 1000,
              style: inputStyle,
              value: form.indexMinBytes,
              onChange: (e) => set("indexMinBytes", e.target.value),
            }),
            "字节起 · 最多",
            h("input", {
              type: "number",
              min: 1,
              step: 10,
              style: { ...inputStyle, width: 76 },
              value: form.indexMaxFiles,
              onChange: (e) => set("indexMaxFiles", e.target.value),
            }),
            "个文件",
          ),
        ),

        h(
          Field,
          {
            label: "压缩阈值（只读）",
            hint: "属于 @deepseek-ai/dsh-compaction-basic，启动时冻结。要改请在 profile 的 cordis.patch.yml 里给 compaction-basic 配 thresholdRatio，然后重启。",
          },
          h(
            "div",
            { style: { fontSize: 13, color: C.muted } },
            `阈值 ${cfg.thresholdRatio} · 保留尾部 ${cfg.retainRatio}`,
          ),
        ),

        h(
          Field,
          { label: "引擎状态" },
          h(
            "div",
            { style: { fontSize: 13, lineHeight: 1.7 } },
            h("div", null, `压缩引擎：${cfg.engine}`),
            h(
              "div",
              null,
              "交接摘要：",
              cfg.handoffInstalled
                ? h("span", { style: { color: C.ok } }, "已安装")
                : h("span", { style: { color: C.muted } }, "未安装"),
            ),
            h("div", { style: { color: C.muted, fontSize: 12, wordBreak: "break-all" } }, cfg.configPath),
          ),
        ),

        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 12, marginTop: 14 } },
          h(
            "button",
            { type: "button", style: btnStyle, disabled: busy, onClick: save },
            busy ? "保存中…" : "保存",
          ),
          h("button", { type: "button", style: btnGhostStyle, disabled: busy, onClick: load }, "重新读取"),
          msg ? h("span", { style: { color: C.ok, fontSize: 13 } }, msg) : null,
          error ? h("span", { style: { color: C.bad, fontSize: 13 } }, error) : null,
        ),
      );
    }

    const inject = ["slots"];

    function applyPlugin(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject(
            "settings.section",
            () =>
              ctx.slots.register(
                { name: "settings.section", id: SECTION_ID, order: 60, label: () => "够用" },
                EnoughSection,
              ),
            "dsh-enough: settings section",
          ),
        "dsh-enough: settings section",
      );
    }

    exp.apply = applyPlugin;
    exp.inject = inject;
    exp.EnoughSection = EnoughSection;
    return exp;
  },
});
