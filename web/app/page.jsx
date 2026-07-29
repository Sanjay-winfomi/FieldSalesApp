// Single entry route — this app has no URL-based routing (it never used
// React Router; navigation is internal component state in App.jsx), so the
// whole app mounts on the one root route, same as index.html did before.
import App from '../src/App';

export default function Page() {
  return <App />;
}
