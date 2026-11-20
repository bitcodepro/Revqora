import { Component, type ReactNode } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { recordError } from "../lib/errorLog";

interface Props {
  /** What stopped working, as the user knows it: "Explorer", "Notifications". */
  area: string;
  /** A new value (another repository) shows the area again after a failure. */
  resetKey?: unknown;
  /** Hidden areas (notifications, dialogs, menus) recover by themselves, without a message. */
  quiet?: boolean;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** A failure while drawing one part of the window stays in that part: without a boundary,
 *  React removes the whole window and leaves it blank while Git work goes on unseen. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  private retry: number | undefined;
  private failures = 0;
  private lastFailure = 0;

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown) {
    recordError("JavaScript", error);
    // A quiet area draws itself afresh a moment later. One failing again and again stays empty
    // for a minute, then tries again.
    const now = Date.now();
    this.failures = now - this.lastFailure > 60_000 ? 1 : this.failures + 1;
    this.lastFailure = now;
    if (this.props.quiet) this.retry = window.setTimeout(this.reset, this.failures <= 3 ? 500 : 60_000);
  }

  componentDidUpdate(previous: Props) {
    if (this.state.error && !Object.is(previous.resetKey, this.props.resetKey)) this.reset();
  }

  componentWillUnmount() {
    window.clearTimeout(this.retry);
  }

  reset = () => {
    window.clearTimeout(this.retry);
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.quiet) return null;
    return <div className="empty view-error" role="alert">
      <div className="big"><CircleAlert size={24} /></div>
      <h3>{this.props.area} stopped working</h3>
      <p className="view-error-message">{error.message || error.name}</p>
      <p>Your repositories are not affected. The error is in the error log.</p>
      <div className="hstack" style={{ gap: 8 }}>
        <button type="button" className="btn primary" onClick={this.reset}><RefreshCw size={14} /> Show again</button>
        <button type="button" className="btn" onClick={() => window.location.reload()}>Reload window</button>
      </div>
    </div>;
  }
}
