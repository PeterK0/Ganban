import { useState, useEffect } from 'react';
import { confirmDialog } from '../lib/confirm';
import { User, CreateUserInput, UpdateUserInput } from '../types';
import { getUsers, createUser, updateUser, deleteUser, setUserPin } from '../lib/api';
import UserEditor from './UserEditor';

export default function UsersView() {
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    try {
      const loadedUsers = await getUsers();
      setUsers(loadedUsers);
    } catch (error) {
      console.error('Failed to load users:', error);
      alert('Failed to load users');
    }
  };

  const handleCreateUser = () => {
    setSelectedUser(null);
    setIsEditorOpen(true);
  };

  const handleEditUser = (user: User) => {
    setSelectedUser(user);
    setIsEditorOpen(true);
  };

  const handleSaveUser = async (userData: CreateUserInput | UpdateUserInput) => {
    try {
      if (selectedUser) {
        // Update existing user
        await updateUser(selectedUser.id, userData as UpdateUserInput);
      } else {
        // Create new user
        await createUser(userData as CreateUserInput);
      }
      await loadUsers();
      setIsEditorOpen(false);
      setSelectedUser(null);
    } catch (error) {
      console.error('Failed to save user:', error);
      alert(`Failed to save user: ${error}`);
    }
  };

  const handleDeleteUser = async () => {
    if (!selectedUser) return;

    if (!await confirmDialog(`Are you sure you want to delete user "${selectedUser.full_name}"? This action cannot be undone.\n\nTip: deactivating (uncheck "Active" in the editor) is usually better — it revokes their devices and hides the profile without touching history.`)) {
      return;
    }

    try {
      await deleteUser(selectedUser.id);
      await loadUsers();
      setIsEditorOpen(false);
      setSelectedUser(null);
    } catch (error) {
      console.error('Failed to delete user:', error);
      alert(`Failed to delete user: ${error}\n\nIf they have chat history the delete is blocked — deactivate them instead.`);
    }
  };

  // Owner reset for a forgotten PIN (set/changed by each user in their Profile).
  const handleClearPin = async (user: User, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!await confirmDialog(`Remove the PIN from "${user.full_name}"? Their profile becomes switchable without a PIN until they set a new one.`)) return;
    try {
      await setUserPin(user.id, null);
      await loadUsers();
    } catch (error) {
      alert(`Failed to clear PIN: ${error}`);
    }
  };

  // Filter users based on search query
  const filteredUsers = users.filter((user) => {
    const query = searchQuery.toLowerCase();
    return (
      user.username.toLowerCase().includes(query) ||
      user.full_name.toLowerCase().includes(query) ||
      (user.email && user.email.toLowerCase().includes(query))
    );
  });

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="g-h2 justify-start mb-1">Users</h1>
            <p className="text-sm text-subtext0 mt-1">
              Manage user profiles and accounts
            </p>
          </div>
          <button
            onClick={handleCreateUser}
            className="g-btn g-btn-pri"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Create User
          </button>
        </div>

        {/* Search Bar */}
        <div className="relative">
          <input
            type="text"
            placeholder="Search users by name, username, or email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="g-field pl-10"
          />
          <svg
            className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-subtext0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        {/* Users Grid */}
        {filteredUsers.length === 0 ? (
          <div className="text-center py-12 g-plain">
            <svg
              className="w-16 h-16 mx-auto text-subtext0 mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <p className="text-subtext0 text-lg">
              {searchQuery ? 'No users found matching your search' : 'No users yet'}
            </p>
            {!searchQuery && (
              <p className="text-subtext0 text-sm mt-2">
                Create your first user to get started
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredUsers.map((user) => (
              <button
                key={user.id}
                onClick={() => handleEditUser(user)}
                className="g-card p-4 hover:bg-surface-0 transition-colors text-left group"
              >
                <div className="flex items-start gap-3">
                  {/* Avatar */}
                  <div className={`g-av w-12 h-12 text-base ${user.is_active ? '' : 'opacity-50'}`}>
                    {user.full_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                  </div>

                  {/* User Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-text truncate">
                        {user.full_name}
                      </h3>
                      {!user.is_active && (
                        <span className="g-tag">
                          Inactive
                        </span>
                      )}
                      {user.is_owner && (
                        <span className="g-tag text-gold">
                          Owner
                        </span>
                      )}
                      {user.has_pin && (
                        <span
                          onClick={(e) => void handleClearPin(user, e)}
                          title="PIN set — click to clear it (owner reset for a forgotten PIN)"
                          className="text-xs px-2 py-0.5 bg-surface-2 text-subtext0 rounded hover:text-error cursor-pointer"
                        >
                          🔒 PIN
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-subtext0 truncate">
                      @{user.username}
                    </p>
                    {user.email && (
                      <p className="text-xs text-subtext0 truncate mt-1">
                        {user.email}
                      </p>
                    )}
                    <p className="text-xs text-subtext0 mt-2">
                      Created {new Date(user.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* User Info */}
        <div className="g-plain p-4">
          <h3 className="text-sm font-semibold text-text mb-2">About profiles</h3>
          <p className="text-xs text-subtext0">
            These are the profiles on this host. <span className="text-text">Deactivating</span> a profile hides it from
            pickers, stops its enrolled devices from authenticating, and keeps all history — prefer it over deleting.
            Profiles with a <span className="text-text">PIN</span> ask for it on every switch and at launch; each member sets
            their own under Settings → Profile, and you can clear a forgotten one here.
          </p>
        </div>
      </div>

      {/* User Editor Modal */}
      {isEditorOpen && (
        <UserEditor
          user={selectedUser}
          onSave={handleSaveUser}
          onDelete={selectedUser ? handleDeleteUser : undefined}
          onClose={() => {
            setIsEditorOpen(false);
            setSelectedUser(null);
          }}
        />
      )}
    </div>
  );
}
