export function setup(ctx) {
    const removeStyle = ctx.dom.addStyle(`
    .lumibionic-fix {
      font-weight: 700;
    }

    /* Defensive fallbacks; code is already excluded by the backend transform. */
    code .lumibionic-fix,
    pre .lumibionic-fix,
    kbd .lumibionic-fix,
    samp .lumibionic-fix {
      font-weight: inherit;
    }
  `);
    return () => {
        removeStyle();
        ctx.dom.cleanup();
    };
}
