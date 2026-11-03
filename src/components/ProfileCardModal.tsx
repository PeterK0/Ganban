import type { User } from '../types';
import { parseProfile } from '../lib/profile';
import ProfileCard from './ProfileCard';
import { Modal } from './gilt';

/** A small desktop modal that shows one user's themed ProfileCard (read-only) —
 * opened by tapping a comment author or a project member. */
export default function ProfileCardModal({ user, onClose }: { user: User; onClose: () => void }) {
  // Esc and a click on the scrim close it, through Modal.
  return (
    <Modal onClose={onClose} className="w-[min(420px,calc(100vw-32px))] p-6">
      <ProfileCard name={user.full_name} username={user.username} profile={parseProfile(user.profile_json)} />
      <div className="text-center mt-4">
        <button onClick={onClose} className="g-btn g-btn-ghost">
          Close
        </button>
      </div>
    </Modal>
  );
}
