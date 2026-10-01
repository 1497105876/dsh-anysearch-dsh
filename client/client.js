// client/client.js — @gw/dsh-anysearch-dsh 浏览器半（插件配置面板）。
//
// 注册到官方插件管理页的 `plugins.bundle.config` 插槽（key = 包名），
// 渲染在该插件详情页的 description 与 rows 之间（view: 'page'）。
// 数据经 host 半的 webServer 路由 /gw-anysearch-dsh/config 同源读写；
// POST 由服务端经 configEditor 持久化并热重载，保存即生效，无需重启。
//
// 形状对齐 shipped ui-* 包的 bundle：window.__ModuleLoader__.load + plain CJS，
// react 来自平台基础模块表。样式只引用官方 --dsw-alias-* 设计令牌。

window.__ModuleLoader__.load({
  id: "@gw/dsh-anysearch-dsh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = null;
    try { React = require("react") || null; } catch (e) { React = null; }

    var SLOT_NAME = "plugins.bundle.config";
    var SLOT_KEY = "@gw/dsh-anysearch-dsh";
    var API = "/gw-anysearch-dsh";

    var styles = {
      wrap: { display: "flex", flexDirection: "column", gap: 10, maxWidth: 560 },
      row: { display: "flex", alignItems: "center", gap: 12 },
      label: { fontSize: 13, color: "var(--dsw-alias-label-primary, inherit)" },
      hint: { fontSize: 11, lineHeight: "17px", color: "var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary, inherit))" },
      input: {
        width: 88, height: 32, borderRadius: 8, padding: "0 10px",
        border: "1px solid var(--dsw-alias-border-primary, rgba(127,127,127,.4))",
        background: "transparent", color: "inherit",
        fontVariantNumeric: "tabular-nums", boxSizing: "border-box"
      },
      button: {
        height: 28, padding: "0 14px", borderRadius: 18, border: "none",
        cursor: "pointer", fontWeight: 500, color: "var(--dsw-alias-label-invert, #fff)",
        background: "var(--dsw-alias-bg-accent, #4f46e5)"
      },
      buttonDisabled: { opacity: 0.5, cursor: "default" },
      statusOk: { fontSize: 11, lineHeight: "17px", color: "var(--dsw-alias-label-success, #1e8e3e)" },
      statusError: { fontSize: 11, lineHeight: "17px", color: "var(--dsw-alias-label-critical, #c0392b)" },
      statusBusy: { fontSize: 11, lineHeight: "17px", color: "var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary, inherit))" }
    };

    function AnySearchConfigPanel(props) {
      var view = props && typeof props.view === "string" ? props.view : "page";
      var useState = React.useState;
      var useEffect = React.useEffect;

      var aliveRef = { value: true };
      useEffect(function () {
        aliveRef.value = true;
        return function () { aliveRef.value = false; };
      }, []);

      var valueState = useState("");
      var value = valueState[0];
      var setValue = valueState[1];
      var loadedState = useState(false);
      var loaded = loadedState[0];
      var setLoaded = loadedState[1];
      var statusState = useState({ kind: "idle", text: "" });
      var status = statusState[0];
      var setStatus = statusState[1];

      useEffect(function () {
        var alive = true;
        fetch(API + "/config")
          .then(function (response) { return response.json(); })
          .then(function (data) {
            if (!alive) return;
            setValue(String(data && data.maxBatchSearches !== undefined ? data.maxBatchSearches : 5));
            setLoaded(true);
          })
          .catch(function () {
            if (!alive) return;
            setLoaded(true);
            setStatus({ kind: "error", text: "读取当前配置失败" });
          });
        return function () { alive = false; };
      }, []);

      if (view === "summary") {
        return React.createElement(
          "span", null,
          "批量搜索并发上限：" + (value || "5")
        );
      }

      function save() {
        var parsed = Number(value);
        setStatus({ kind: "busy", text: "" });
        fetch(API + "/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ maxBatchSearches: parsed })
        })
          .then(function (response) {
            return response.json().then(function (data) { return { ok: response.ok, data: data }; });
          })
          .then(function (result) {
            if (!aliveRef.value) return;
            if (!result.ok) {
              setStatus({ kind: "error", text: (result.data && result.data.error) || "保存失败" });
              return;
            }
            setStatus({ kind: "ok", text: "已保存，配置已热重载生效" });
          })
          .catch(function (error) {
            if (!aliveRef.value) return;
            setStatus({ kind: "error", text: "保存失败：" + (error && error.message ? error.message : error) });
          });
      }

      var statusStyle = status.kind === "error" ? styles.statusError
        : status.kind === "ok" ? styles.statusOk
        : styles.statusBusy;

      return React.createElement("div", { style: styles.wrap },
        React.createElement("div", { style: styles.row },
          React.createElement("label", { style: styles.label, htmlFor: "gw-anysearch-max-batch" }, "批量搜索并发上限"),
          React.createElement("input", {
            id: "gw-anysearch-max-batch",
            style: styles.input,
            type: "number",
            min: 1,
            max: 20,
            step: 1,
            value: value,
            disabled: !loaded,
            onChange: function (event) { setValue(event.target.value); }
          }),
          React.createElement("button", {
            style: loaded && status.kind !== "busy" ? styles.button : Object.assign({}, styles.button, styles.buttonDisabled),
            type: "button",
            disabled: !loaded || status.kind === "busy",
            onClick: function () { save(); }
          }, status.kind === "busy" ? "保存中…" : "保存")
        ),
        React.createElement("div", { style: styles.hint },
          "anysearch_batch_search 单次最多并发发起的搜索请求数（1–20，默认 5）。保存后写入 profile 配置并热重载，立即生效。"),
        status.text ? React.createElement("div", { style: statusStyle }, status.text) : null
      );
    }

    /** Mount the panel into the official plugin-manager configuration slot. */
    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") return;
      ctx.slots.inject(SLOT_NAME, function () {
        return ctx.slots.register({
          name: SLOT_NAME,
          key: SLOT_KEY
        }, AnySearchConfigPanel);
      });
    }

    exports.apply = apply;
    return module.exports;
  }
});
