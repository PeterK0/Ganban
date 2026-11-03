import { useState, useEffect } from 'react';
import { Modal } from './gilt';
import { User, CreateUserInput, UpdateUserInput } from '../types';

interface UserEditorProps {
  user: User | null;
  onSave: (userData: CreateUserInput | UpdateUserInput) => void;
  onDelete?: () => void;
  onClose: () => void;
}

export default function UserEditor({ user, onSave, onDelete, onClose }: UserEditorProps) {
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    if (user) {
      setUsername(user.username);
      setFullName(user.full_name);
      setEmail(user.email || '');
      setIsActive(user.is_active);
    } else {
      setUsername('');
      setFullName('');
      setEmail('');
      setIsActive(true);
    }
  }, [user]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!fullName.trim()) {
      alert('Full name is required');
      return;
    }

    if (!user && !username.trim()) {
      alert('Username is required for new users');
      return;
    }

    if (user) {
      // Update existing user
      const updateData: UpdateUserInput = {
        full_name: fullName.trim(),
        email: email.trim() || undefined,
        is_active: isActive,
      };
      onSave(updateData);
    } else {
      // Create new user
      const createData: CreateUserInput = {
        username: username.trim(),
        full_name: fullName.trim(),
        email: email.trim() || undefined,
      };
      onSave(createData);
    }
  };

  return (
    <Modal onClose={onClose} title={user ? 'Edit User' : 'Create User'} closeOnScrim={false} className="w-[min(560px,calc(100vw-32px))] max-h-[90vh]">
        <button
          onClick={onClose}
          className="g-iconbtn absolute top-3 right-3"
          aria-label="Close"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Form */}
        <form onSubmit={handleSubmit} className="g-form flex-1 overflow-y-auto px-6 pb-4 space-y-4">
          {/* Username (only for new users) */}
          {!user && (
            <div>
              <label className="block text-sm font-medium text-text mb-2">
                Username <span className="text-red">*</span>
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="g-field"
                placeholder="Enter username"
                required
              />
              <p className="text-xs text-subtext0 mt-1">
                Username cannot be changed after creation
              </p>
            </div>
          )}

          {/* Full Name */}
          <div>
            <label className="block text-sm font-medium text-text mb-2">
              Full Name <span className="text-red">*</span>
            </label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="g-field"
              placeholder="Enter full name"
              required
            />
          </div>

          {/* Email */}
          <div>
            <label className="block text-sm font-medium text-text mb-2">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="g-field"
              placeholder="user@example.com"
            />
          </div>

          {/* Active Status (only for existing users) */}
          {user && (
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="w-4 h-4 rounded"
                />
                <span className="text-sm text-text">User is active</span>
              </label>
              <p className="text-xs text-subtext0 mt-1 ml-6">
                Inactive users cannot be selected in the user switcher
              </p>
            </div>
          )}

          {/* User Info (for existing users) */}
          {user && (
            <div className="g-card p-4 space-y-1">
              <div className="text-xs text-subtext0">
                <span className="font-medium">Username:</span> {user.username}
              </div>
              <div className="text-xs text-subtext0">
                <span className="font-medium">Created:</span>{' '}
                {new Date(user.created_at).toLocaleDateString()}
              </div>
            </div>
          )}
        </form>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gilt-b flex items-center justify-between gap-3">
          <div>
            {user && onDelete && (
              <button
                type="button"
                onClick={onDelete}
                className="g-btn g-btn-danger"
              >
                Delete User
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="g-btn g-btn-ghost"
            >
              Cancel
            </button>
            <button
              type="submit"
              onClick={handleSubmit}
              className="g-btn g-btn-pri"
            >
              {user ? 'Save Changes' : 'Create User'}
            </button>
          </div>
        </div>
    </Modal>
  );
}
