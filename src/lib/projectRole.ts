import { useEffect, useState } from 'react';
import { getProjectMemberOverview } from './api';
import { getMe, isDesktopOnline, isMobilePlatform, isTauri } from './daemon';
import type { ProjectMemberOverview } from '../types';

/**
 * Who "I" am on a project's host, and whether I may manage it: its members, areas, and
 * who sees its tasks (task visibility, ADR 0002). The desktop in local mode IS the host
 * (loopback = owner), so it always may. For a remote project (K2: the active transport
 * points at its host), "me" is the host's own user id from /me, not the local
 * currentUserId (a different number space). The host's owner may manage every project.
 */
export function useProjectRole(projectId: number | null | undefined) {
  const isLocalHost = isTauri() && !isMobilePlatform() && !isDesktopOnline();
  const [hostMeId, setHostMeId] = useState<number | null>(null);
  const [hostIsOwner, setHostIsOwner] = useState(false);
  const [members, setMembers] = useState<ProjectMemberOverview[]>([]);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (isLocalHost) {
      setHostMeId(null);
      setHostIsOwner(false);
      return;
    }
    let cancelled = false;
    getMe()
      .then((me) => {
        if (!cancelled) {
          setHostMeId(me.user.id);
          setHostIsOwner(!!me.user.is_owner);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHostMeId(null);
          setHostIsOwner(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, isLocalHost]);

  useEffect(() => {
    if (projectId == null) return;
    let cancelled = false;
    getProjectMemberOverview(projectId)
      .then((m) => !cancelled && setMembers(m))
      .catch(() => !cancelled && setMembers([]));
    return () => {
      cancelled = true;
    };
  }, [projectId, nonce]);

  const myId = isLocalHost ? Number(localStorage.getItem('currentUserId')) || null : hostMeId;
  const myRole = members.find((m) => m.user_id === myId)?.role;
  return {
    /** The project's members (with roles), for pickers. */
    members,
    myId,
    myRole,
    /** The host's owner, connected from any device (or the desktop that IS the host). */
    isOwner: isLocalHost || hostIsOwner,
    /** An owner or admin of this project, or the host's owner. */
    canManage: isLocalHost || hostIsOwner || myRole === 'owner' || myRole === 'admin',
    /** Re-read the member list (after a role change). */
    reload: () => setNonce((n) => n + 1),
  };
}
