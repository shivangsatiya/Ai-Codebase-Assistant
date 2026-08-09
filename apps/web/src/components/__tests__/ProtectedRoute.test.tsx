import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ProtectedRoute } from '../ProtectedRoute';
import { useAuthStore } from '../../stores/auth-store';

function renderProtected(isAuthenticated: boolean) {
  useAuthStore.setState({ isAuthenticated });

  return render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Routes>
        <Route path="/login" element={<div>Login screen</div>} />
        <Route
          path="/workspace"
          element={
            <ProtectedRoute>
              <div>Workspace content</div>
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: null, refreshToken: null, isAuthenticated: false });
  });

  it('renders the protected content when the user is authenticated', () => {
    renderProtected(true);

    expect(screen.getByText('Workspace content')).toBeInTheDocument();
    expect(screen.queryByText('Login screen')).not.toBeInTheDocument();
  });

  it('redirects to /login, never rendering the protected content, when the user is not authenticated', () => {
    renderProtected(false);

    expect(screen.getByText('Login screen')).toBeInTheDocument();
    expect(screen.queryByText('Workspace content')).not.toBeInTheDocument();
  });
});
