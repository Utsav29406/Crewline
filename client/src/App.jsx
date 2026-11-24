import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useApp } from './context.jsx';
import Layout from './components/Layout.jsx';
import { Loading } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import LiveMap from './pages/LiveMap.jsx';
import Payroll from './pages/Payroll.jsx';
import Payslips from './pages/Payslips.jsx';
import Dashboard from './pages/Dashboard.jsx';
import MyDashboard from './pages/MyDashboard.jsx';
import Punch from './pages/Punch.jsx';
import Attendance from './pages/Attendance.jsx';
import Leaves from './pages/Leaves.jsx';
import Employees from './pages/Employees.jsx';
import Geofences from './pages/Geofences.jsx';
import Reports from './pages/Reports.jsx';
import Settings from './pages/Settings.jsx';
import Profile from './pages/Profile.jsx';
import Activity from './pages/Activity.jsx';
import Tasks from './pages/Tasks.jsx';
import Legal from './pages/Legal.jsx';
import Join from './pages/Join.jsx';
import Invite from './pages/Invite.jsx';
import History from './pages/History.jsx';

/** An invite opened in a browser where someone is already signed in: offer to sign out first, keeping the link. */
function InviteWhileSignedIn() {
  const { user, logout } = useApp();
  return (
    <div className="auth-solo">
      <div className="card auth-card stack" style={{ padding: 32, textAlign: 'center' }}>
        <h2 style={{ fontSize: 22, margin: 0 }}>Accept your invite</h2>
        <p className="muted" style={{ margin: 0 }}>
          This browser is signed in as <b>{user.name}</b>. Sign out to set the password for your invite.
        </p>
        <button className="btn btn-primary btn-block" onClick={() => logout()}>Sign out and continue</button>
        <Link to="/" className="btn btn-block">Stay signed in</Link>
      </div>
    </div>
  );
}

export default function App() {
  const { user, booting, isManager } = useApp();
  if (booting) return <Loading />;
  if (!user) {
    return (
      <Routes>
        <Route path="/register" element={<Register />} />
        <Route path="/join" element={<Join />} />
        <Route path="/join/:code" element={<Join />} />
        <Route path="/invite" element={<Invite />} />
        <Route path="/privacy" element={<Legal page="privacy" />} />
        <Route path="/terms" element={<Legal page="terms" />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  const managerOnly = (el) => (isManager ? el : <Navigate to="/" replace />);
  return (
    <Routes>
      <Route path="/invite" element={<InviteWhileSignedIn />} />
      <Route path="/privacy" element={<Legal page="privacy" />} />
      <Route path="/terms" element={<Legal page="terms" />} />
      <Route element={<Layout />}>
        <Route index element={isManager ? <Dashboard /> : <MyDashboard />} />
        <Route path="punch" element={<Punch />} />
        <Route path="attendance" element={<Attendance />} />
        <Route path="leaves" element={<Leaves />} />
        <Route path="profile" element={<Profile />} />
        <Route path="payslips" element={<Payslips />} />
        <Route path="activity" element={<Activity />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="payroll" element={managerOnly(<Payroll />)} />
        <Route path="live-map" element={managerOnly(<LiveMap />)} />
        <Route path="employees" element={managerOnly(<Employees />)} />
        <Route path="geofences" element={managerOnly(<Geofences />)} />
        <Route path="reports" element={managerOnly(<Reports />)} />
        <Route path="settings" element={managerOnly(<Settings />)} />
        <Route path="history" element={managerOnly(<History />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
