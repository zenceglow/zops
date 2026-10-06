import { Navigate } from 'react-router-dom';

export default function MembersPage() {
  return <Navigate to="/settings/panel?section=members" replace />;
}
