import LocalVideoWorkspace from './components/LocalVideoWorkspace';
import AccessGate from './components/AccessGate';

export default function App() {
  return <AccessGate><LocalVideoWorkspace /></AccessGate>;
}
