import { useState, useEffect, useRef } from 'react';
import { User } from '../types';
import { getActiveUsers, verifyUserPin } from '../lib/api';

interface UserSwitcherProps {
  currentUserId: number | null;
  onUserChange: (userId: number) => void;
}

export default function UserSwitcher({ currentUserId, onUserChange }: UserSwitcherProps) {
  const [users, setUsers] = useState<User[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadUsers();
  }, []);

  useEffect(() => {
    if (users.length > 0 && currentUserId) {
      const user = users.find(u => u.id === currentUserId);
      if (user) {
        setCurrentUser(user);
      }
    }
  }, [users, currentUserId]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const loadUsers = async () => {
    try {
      const loadedUsers = await getActiveUsers();
      setUsers(loadedUsers);
    } catch (error) {
      console.error('Failed to load users:', error);
    }
  };

  // Switching to a PIN-protected profile asks for THAT profile's PIN inline.
  const [pinTarget, setPinTarget] = useState<User | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  const handleUserSelect = (user: User) => {
    if (user.id === currentUserId) {
      setIsOpen(false);
      return;
    }
    if (user.has_pin) {
      setPinTarget(user);
      setPin('');
      setPinError(null);
      return;
    }
    onUserChange(user.id);
    setIsOpen(false);
  };

  const submitPin = async () => {
    if (!pinTarget || pin.length < 4) return;
    try {
      if (await verifyUserPin(pinTarget.id, pin)) {
        onUserChange(pinTarget.id);
        setPinTarget(null);
        setIsOpen(false);
      } else {
        setPinError('Wrong PIN');
        setPin('');
      }
    } catch (e) {
      setPinError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!currentUser) {
    return null;
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-surface-1 transition-colors group"
      >
        {/* Avatar */}
        <div className="g-av w-8 h-8 text-xs">
          {currentUser.full_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
        </div>

        {/* User Name */}
        <div className="flex flex-col items-start">
          <span className="text-sm font-medium text-text">
            {currentUser.full_name}
          </span>
          <span className="text-xs text-subtext0">
            @{currentUser.username}
          </span>
        </div>

        {/* Dropdown Arrow */}
        <svg
          className={`w-4 h-4 text-subtext0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute top-full right-0 mt-2 w-64 g-card shadow-lg z-50 overflow-hidden">
          <div className="p-2 border-b border-surface-2">
            <p className="text-xs text-subtext0 px-2 py-1">Switch User</p>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {users.map((user) => (
              <button
                key={user.id}
                onClick={() => handleUserSelect(user)}
                className={`w-full flex items-center gap-3 px-3 py-2 hover:bg-surface-1 transition-colors text-left ${
                  user.id === currentUserId ? 'g-sel' : ''
                }`}
              >
                {/* Avatar */}
                <div className={`g-av w-8 h-8 text-xs ${user.id === currentUserId ? '' : 'opacity-60'}`}>
                  {user.full_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                </div>

                {/* User Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text truncate">
                      {user.full_name}
                    </span>
                    {user.id === currentUserId && (
                      <svg className="w-4 h-4 text-green flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </div>
                  <span className="text-xs text-subtext0 truncate block">
                    @{user.username}
                  </span>
                </div>
                {user.has_pin && <span className="text-subtext0 text-xs">🔒</span>}
              </button>
            ))}
          </div>

          {pinTarget && (
            <div className="p-3 border-t border-surface-2 space-y-2">
              <p className="text-xs text-subtext0">PIN for {pinTarget.full_name}</p>
              <div className="flex gap-2">
                <input
                  autoFocus
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={8}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitPin();
                  }}
                  placeholder="••••"
                  className="flex-1 min-w-0 px-2 py-1.5 text-sm text-center tracking-widest bg-surface-1 border border-surface-2 rounded-lg focus:outline-none focus:border-primary"
                />
                <button
                  onClick={() => void submitPin()}
                  disabled={pin.length < 4}
                  className="px-3 py-1.5 text-sm bg-primary text-primary-text rounded-lg disabled:opacity-50"
                >
                  Switch
                </button>
              </div>
              {pinError && <p className="text-xs text-error">{pinError}</p>}
            </div>
          )}

          {users.length === 0 && (
            <div className="p-4 text-center text-sm text-subtext0">
              No active users available
            </div>
          )}
        </div>
      )}
    </div>
  );
}
