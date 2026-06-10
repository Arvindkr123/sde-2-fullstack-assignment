import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { getToken, clearToken } from './api';
import Login from './pages/Login';
import Register from './pages/Register';
import Sequences from './pages/Sequences';
import SequenceDetail from './pages/SequenceDetail';
import MailboxQuota from './pages/MailboxQuota';

function Layout() {
  const navigate = useNavigate();

  function logout() {
    clearToken();
    navigate('/login');
  }

  return (
    <>
      <nav className="nav">
        <a href="/" className="nav-brand">Sequencer</a>
        <NavLink to="/sequences" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          Sequences
        </NavLink>
        <NavLink to="/quota" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          Mailbox Quota
        </NavLink>
        <span className="nav-spacer" />
        <button className="btn-secondary btn-sm" onClick={logout}>Logout</button>
      </nav>
      <Routes>
        <Route path="/sequences" element={<Sequences />} />
        <Route path="/sequences/:id" element={<SequenceDetail />} />
        <Route path="/quota" element={<MailboxQuota />} />
        <Route path="*" element={<Navigate to="/sequences" replace />} />
      </Routes>
    </>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
