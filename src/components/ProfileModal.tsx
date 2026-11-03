import ProfileEditor from './ProfileEditor';
import ScrollArea from './ScrollArea';
import { Modal } from './gilt';

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: number | null;
  onSaved?: () => void;
}

/** Desktop "My profile" editor modal — thin chrome around the shared
 * ProfileEditor (also embedded in Settings → Profile). */
export default function ProfileModal({ isOpen, onClose, userId, onSaved }: ProfileModalProps) {
  // Esc closes through Modal.
  if (!isOpen) return null;

  return (
    // No close-on-backdrop: this is an editor — don't discard edits on a stray click.
    <Modal onClose={onClose} title="My profile" closeOnScrim={false} className="w-[min(860px,calc(100vw-32px))] max-h-[88vh]">
      <ScrollArea className="flex-1 min-h-0" contentClassName="g-form px-6 pb-6">
        <ProfileEditor
          userId={userId}
          onSaved={() => {
            onSaved?.();
            onClose();
          }}
        />
      </ScrollArea>

      {/* After the content, so focus starts on the content, not on ✕. */}
      <button onClick={onClose} className="g-iconbtn absolute top-3 right-3" aria-label="Close">✕</button>
    </Modal>
  );
}
