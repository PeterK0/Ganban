import { Component, type ReactNode } from 'react';

/**
 * Wraps a stash tab's panel: an error thrown inside one tab shows a small card in its
 * place instead of unmounting the whole app. "Reload tab" remounts the panel.
 */
export default class TabErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; nonce: number }> {
  state = { error: null as Error | null, nonce: 0 };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error('tab panel error', error);
  }
  render() {
    if (!this.state.error) return <Reset key={this.state.nonce}>{this.props.children}</Reset>;
    return (
      <div className="flex-1 grid place-items-center p-8">
        <div role="alert" className="g-card g-corners max-w-sm px-6 py-6 text-center text-sm">
          <p className="g-deco text-gold text-[13px] font-semibold">This tab hit an error</p>
          <p className="mt-1 text-xs text-subtext-0 break-words">{this.state.error.message.slice(0, 200)}</p>
          <button
            type="button"
            onClick={() => this.setState((s) => ({ error: null, nonce: s.nonce + 1 }))}
            className="g-btn g-btn-pri g-btn-sm mt-3"
          >
            Reload tab
          </button>
        </div>
      </div>
    );
  }
}

/** A keyed pass-through, so a bumped nonce remounts the panel from scratch. */
function Reset({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
