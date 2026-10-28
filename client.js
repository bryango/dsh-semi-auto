/**
 * Semi Auto composer toggle (browser half): one compact switch in the
 * composer tool row (`conversation.input.left`), rendered right of the native
 * permission control. Flipping it calls the node half's `/api` RPC endpoints;
 * the component holds only viewing state and re-reads on a slow poll, so a
 * transient RPC failure keeps the last known state instead of hiding the
 * control. Every color resolves through `--dsw-alias-*` design tokens and
 * every string through the locale seat, mirroring the host's own controls.
 */
window.__ModuleLoader__.load({
  id: 'dsh-semi-auto',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useRef, useEffect } = React;

    const NS = 'composer.semi-auto';
    const CHANNEL = '/api';
    const PREFIX = 'semi-auto.';
    const POLL_INTERVAL_MS = 3000;

    const en = {
      label: 'Semi Auto',
      titleOn: 'Semi Auto is on: widening calls get the human popup plus Auto review. Click to turn off.',
      titleOff: 'Semi Auto is off: native approval handles every call. Click to turn on.',
      failed: 'Semi Auto status unavailable; retrying.',
    };
    const zh = {
      label: '半自动',
      titleOn: 'Semi Auto 已开启:提权调用走人工弹窗加 Auto review。点击关闭。',
      titleOff: 'Semi Auto 已关闭:所有调用走原生审批。点击开启。',
      failed: 'Semi Auto 状态读取失败,正在重试。',
    };

    /** Call one node-half endpoint and unwrap the business result. */
    async function callMode(rpc, endpoint, payload) {
      let result;
      try {
        result = await rpc.call(CHANNEL, `${PREFIX}${endpoint}`, payload);
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      if (!result.ok) throw new Error(result.error?.message ?? 'semi-auto rpc failed');
      return result.value;
    }

    function SemiAutoToggle(props) {
      const { loadMode, setMode } = props;
      const translate = props.t ?? (key => en[key] ?? key);
      const [enabled, setEnabled] = useState(null);
      const [busy, setBusy] = useState(false);
      const [failed, setFailed] = useState(false);
      const loadRef = useRef(loadMode);
      loadRef.current = loadMode;

      useEffect(() => {
        if (loadRef.current === undefined) return undefined;
        let cancelled = false;
        let inflight = false;
        const reload = () => {
          const load = loadRef.current;
          if (load === undefined || inflight) return;
          inflight = true;
          load().then(
            value => { if (!cancelled) { setEnabled(value); setFailed(false); } },
            () => { if (!cancelled) setFailed(true); },
          ).finally(() => { inflight = false; });
        };
        reload();
        const timer = setInterval(reload, POLL_INTERVAL_MS);
        return () => { cancelled = true; clearInterval(timer); };
      }, []);

      if (loadMode === undefined || setMode === undefined || enabled === null) return null;

      const toggle = () => {
        if (busy) return;
        setBusy(true);
        setMode(!enabled).then(
          value => { setEnabled(value); setFailed(false); },
          () => { setFailed(true); },
        ).finally(() => { setBusy(false); });
      };

      return h('div', { className: 'dsh-semi-auto-toggle', style: styles.root },
        h('style', null, css),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': enabled,
          'aria-label': translate('label'),
          title: failed ? translate('failed') : enabled ? translate('titleOn') : translate('titleOff'),
          disabled: busy,
          style: styles.trigger,
          onClick: toggle,
        },
          h('span', {
            'aria-hidden': true,
            style: { ...styles.dot, background: enabled
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-state-idle-primary)' },
          }),
          h('span', { style: styles.label }, translate('label')),
        ),
      );
    }

    const styles = {
      root: { position: 'relative', display: 'inline-flex' },
      trigger: {
        display: 'inline-flex', alignItems: 'center', gap: 5,
        border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-sm, 8px)',
        background: 'var(--dsh-semi-auto-hover, transparent)', color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit', fontSize: 12, lineHeight: '18px',
        padding: '2px 8px', cursor: 'pointer', whiteSpace: 'nowrap',
      },
      dot: { width: 6, height: 6, borderRadius: '50%', flexShrink: 0 },
      label: {},
    };

    const css = `
.dsh-semi-auto-toggle button:hover:not(:disabled) {
  --dsh-semi-auto-hover: var(--dsw-alias-interactive-bg-hover);
}
.dsh-semi-auto-toggle button:active:not(:disabled) {
  --dsh-semi-auto-hover: var(--dsw-alias-interactive-bg-active);
}
.dsh-semi-auto-toggle button:disabled { opacity: 0.4; cursor: default; }
.dsh-semi-auto-toggle button:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
`;

    return {
      inject: ['slots', 'connection', 'locale'],
      apply(ctx) {
        const connection = ctx.get('connection');
        if (connection === undefined || connection === null) return;
        const rpc = connection.rpc;
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'dsh-semi-auto: composer toggle copy',
        );
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'semi-auto-toggle',
          order: 0,
          locale: NS,
          inject: () => ({
            loadMode: async () => {
              const value = await callMode(rpc, 'get', {});
              return value.enabled === true;
            },
            setMode: async next => {
              const value = await callMode(rpc, 'set', { enabled: next === true });
              return value.enabled === true;
            },
          }),
        }, SemiAutoToggle));
      },
    };
  },
});
