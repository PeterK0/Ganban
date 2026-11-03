import { Suspense, useEffect, useState } from 'react';
import { confirmDialog } from '../lib/confirm';
import ScrollArea from './ScrollArea';
import { Modal, DecoHeading } from './gilt';
import ProtocolsPanel from './ProtocolsPanel';
import { useAppStore } from '../store/appStore';
import { themes } from '../themes';
import { save, open } from '@tauri-apps/plugin-dialog';
import { hasHostControls, shellOverride, setShellOverride, type Shell } from '../lib/shell';
import {
  exportDatabase,
  importDatabase,
  getStoragePaths,
  type StoragePaths,
  getProjects,
  setProjectQuota,
  getAppSetting,
  setAppSetting,
  createTicket,
  listTickets,
  setTicketStatus,
} from '../lib/api';
import type { Ticket } from '../types';
import { getTomorrowPolicy, setTomorrowPolicy, getDayOfEnabled, setDayOfEnabled, type TomorrowPolicy } from '../lib/reminderPrefs';
import {
  getDaemonBaseUrl,
  testAiConnection,
  pullModel,
  embedTest,
  reembedAll,
  listProfiles,
  upsertProfile,
  deleteProfile,
  setActiveProfile,
  setSecretaryProfile,
  getModelInfo,
  parseModelMeta,
  listOllamaModels,
  setRoutingProfile,
  setTaskProtocol,
  reloadAi,
  isTauri,
  isDesktopOnline,
  setDaemonBaseUrl,
  getMe,
  hasDaemon,
  listSyncFolders,
  createSyncFolder,
  updateSyncFolder,
  deleteSyncFolder,
  runSyncFolder,
  listEmailAccounts,
  createEmailAccount,
  testEmailAccount,
  beginEmailOAuth,
  pollEmailOAuth,
  updateEmailAccount,
  deleteEmailAccount,
  syncEmailAccount,
  type EmailAccount,
  type SyncFolder,
  type ModelProfile,
  type ModelMeta,
  isWebClient,
  isHostedClient,
  setDeviceToken,
} from '../lib/daemon';
import YourDevices from './YourDevices';
import { buildLabel } from '../lib/build';
import { daemonStatus, daemonStart, tailscaleCheck, TOKEN_RENEW_WARN_DAYS, type TailscaleDevice, type TokenExpiry } from '../lib/host';
import UpdatesPanel, { ServeInstallersCard } from './UpdatesPanel';
import { isDesktopApp } from '../lib/update';
import { isGithubBuild } from '../lib/update.pure';
import { UPDATE_CHANNEL } from '../lib/updateChannel';
import { aiEngineStatus, aiEngineStart, aiEngineStop, aiEngineReclaimRagrat, type AiEngineStatus } from '../lib/aiEngine';
import { getGiphyKey, setGiphyKey, searchGifs } from '../lib/giphy';
import { TAB_MODULES } from '../tabs/modules';
import { getTimezone, setTimezone, timezoneList, resolvedTimezone } from '../lib/clock';
import type { Project } from '../types';
import UserSwitcher from './UserSwitcher';
import UsersView from './UsersView';
import ProfileEditor from './ProfileEditor';
import SyncView from './SyncView';
import AutomationsPanel from './AutomationsPanel';
import { ProfileAvatar, ModelCard } from './ModelProfilesPanel';
import ToolsPanel from './ToolsPanel';
import LoadoutsPanel from './LoadoutsPanel';
import DocumentationPanel from './DocumentationPanel';
import DiagnosticsPanel from './DiagnosticsPanel';
import type { SettingsSection } from '../lib/settingsNav';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUserId: number | null;
  onUserChange: (userId: number) => void;
  /** The section to open at; without it the modal keeps the last one. */
  initialSection?: SettingsSection;
}

type Section = SettingsSection;

// Sections grouped into nav categories. The growth of connectivity + AI
// features made a flat list feel scattered; grouping keeps related settings
// together. 'profiles' is host-only (filtered out for online clients).
const SECTION_GROUPS: { group: string; items: { key: Section; label: string }[] }[] = [
  { group: 'General', items: [
    { key: 'design', label: 'Design' },
    { key: 'notifications', label: 'Notifications' },
    { key: 'docs', label: 'Documentation' },
    { key: 'data', label: 'Data & Storage' },
    { key: 'updates', label: 'Updates' },
    { key: 'feedback', label: 'Feedback' },
    { key: 'diagnostics', label: 'Report a bug' },
  ] },
  { group: 'Account', items: [
    { key: 'profile', label: 'Profile' },
    { key: 'account', label: 'Switch user' },
    { key: 'profiles', label: 'Profiles' },
  ] },
  { group: 'AI', items: [
    { key: 'connections', label: 'AI Engines' },
    { key: 'models', label: 'Models' },
    { key: 'personalities', label: 'Personalities' },
    { key: 'loadouts', label: 'Loadouts' },
    { key: 'tools', label: 'Tools' },
    { key: 'plugins', label: 'Plug-ins' },
  ] },
  { group: 'Sharing & devices', items: [
    { key: 'sync', label: 'Sync' },
  ] },
  { group: 'Automations', items: [
    { key: 'automations', label: 'Automations' },
  ] },
];

const DEFAULT_QUOTA_MB = 256;

export default function SettingsModal({ isOpen, onClose, currentUserId, onUserChange, initialSection }: SettingsModalProps) {
  const { currentTheme, setTheme } = useAppStore();
  const [section, setSection] = useState<Section>('design');
  // Opened at a section (openSettings('connections') from a "not set up" screen).
  useEffect(() => {
    if (isOpen && initialSection) setSection(initialSection);
  }, [isOpen, initialSection]);
  // ragrat ingest parallelism — passed as --workers when Ganban launches it.
  const [ragratWorkers, setRagratWorkersState] = useState('1');
  const [ragratWorkersMsg, setRagratWorkersMsg] = useState<string | null>(null);
  const saveRagratWorkers = () => {
    const n = Math.max(1, Math.min(16, Math.round(Number(ragratWorkers)) || 1));
    setRagratWorkersState(String(n));
    setAppSetting('ragrat_workers', String(n))
      .then(() => setRagratWorkersMsg('saved'))
      .catch((e) => setRagratWorkersMsg(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    if (section !== 'connections') return;
    getAppSetting('ragrat_workers')
      .then((v) => v && setRagratWorkersState(v))
      .catch(() => {});
  }, [section]);
  // Folder sync (Plug-ins): mappings from locally-mirrored cloud folders.
  const [sfList, setSfList] = useState<SyncFolder[]>([]);
  const [sfProjects, setSfProjects] = useState<{ id: number; name: string }[]>([]);
  const [sfProjectId, setSfProjectId] = useState<number | ''>('');
  const [sfPath, setSfPath] = useState('');
  const [sfExt, setSfExt] = useState('');
  const [sfMaxMb, setSfMaxMb] = useState('');
  const [sfMsg, setSfMsg] = useState<string | null>(null);
  const [sfBusy, setSfBusy] = useState(false);

  // Email accounts (Plug-ins): the owner's IMAP mailboxes.
  const [emList, setEmList] = useState<EmailAccount[]>([]);
  const [emLabel, setEmLabel] = useState('');
  // Auth method: app password (default) or the user's own Google OAuth client.
  const [emAuth, setEmAuth] = useState<'password' | 'oauth'>('password');
  const [emClientId, setEmClientId] = useState('');
  const [emClientSecret, setEmClientSecret] = useState('');
  const [emFlowId, setEmFlowId] = useState<string | null>(null);
  const [emSignedInAs, setEmSignedInAs] = useState<string | null>(null);
  const [emHost, setEmHost] = useState('');
  const [emPort, setEmPort] = useState('993');
  const [emUser, setEmUser] = useState('');
  const [emPass, setEmPass] = useState('');
  const [emFolders, setEmFolders] = useState('');
  const [emHorizon, setEmHorizon] = useState('90');
  const [emMsg, setEmMsg] = useState<string | null>(null);
  const [emBusy, setEmBusy] = useState(false);

  useEffect(() => {
    if (section !== 'plugins' || !hasDaemon()) return;
    listSyncFolders().then(setSfList).catch(() => setSfList([]));
    listEmailAccounts().then(setEmList).catch(() => setEmList([]));
    getProjects().then((ps) => setSfProjects(ps.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name })))).catch(() => {});
  }, [section]);

  const sfRefresh = () => listSyncFolders().then(setSfList).catch(() => {});
  const sfAdd = async () => {
    if (!sfProjectId || !sfPath.trim() || sfBusy) return;
    setSfBusy(true);
    setSfMsg(null);
    try {
      await createSyncFolder(Number(sfProjectId), sfPath.trim(), sfExt.trim(), sfMaxMb.trim() ? Math.round(Number(sfMaxMb) * 1024 * 1024) : 0);
      setSfPath('');
      setSfExt('');
      setSfMaxMb('');
      await sfRefresh();
      setSfMsg('Folder added — it syncs every few minutes (or Sync now).');
    } catch (e) {
      setSfMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSfBusy(false);
    }
  };
  const sfRun = async (id: number) => {
    setSfBusy(true);
    setSfMsg(null);
    try {
      const r = await runSyncFolder(id);
      setSfMsg(`Synced: ${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged, ${r.filtered} filtered${r.errors.length ? `, ${r.errors.length} failed (${r.errors[0][0]}: ${r.errors[0][1]}${r.errors.length > 1 ? ', …' : ''})` : ''}.`);
      await sfRefresh();
    } catch (e) {
      setSfMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSfBusy(false);
    }
  };
  const sfToggle = async (f: SyncFolder) => {
    try {
      await updateSyncFolder(f.id, { enabled: !f.enabled });
      await sfRefresh();
    } catch (e) {
      setSfMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const sfDelete = async (f: SyncFolder) => {
    if (!(await confirmDialog(`Stop syncing "${f.path}"? Files already imported stay in the project.`))) return;
    try {
      await deleteSyncFolder(f.id);
      await sfRefresh();
    } catch (e) {
      setSfMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const sfBrowse = async () => {
    try {
      const sel = await open({ directory: true, multiple: false });
      if (typeof sel === 'string') setSfPath(sel);
    } catch {
      /* picker unavailable (web client) — type the path instead */
    }
  };

  const emRefresh = () => listEmailAccounts().then(setEmList).catch(() => {});
  const emBody = () => ({
    label: emLabel.trim() || undefined,
    host: emHost.trim(),
    port: emPort.trim() ? Number(emPort) : undefined,
    username: emUser.trim(),
    password: emPass,
    folders: emFolders.trim() || undefined,
    horizon_days: emHorizon.trim() ? Number(emHorizon) : undefined,
    ...(emAuth === 'oauth' && emFlowId
      ? { oauth_flow_id: emFlowId, oauth_client_id: emClientId.trim(), oauth_client_secret: emClientSecret.trim() || undefined }
      : {}),
  });
  // Enough to submit: OAuth needs a completed sign-in; password needs a password.
  const emReady = emAuth === 'oauth' ? !!emFlowId && !!emHost.trim() : !!emHost.trim() && !!emUser.trim() && !!emPass;

  /** Browser sign-in with the user's own Google client (loopback + PKCE). */
  const emSignIn = async () => {
    if (!emClientId.trim() || emBusy) return;
    setEmBusy(true);
    setEmMsg('Opening Google sign-in in your browser…');
    setEmSignedInAs(null);
    setEmFlowId(null);
    try {
      const { flow_id, auth_url } = await beginEmailOAuth(emClientId.trim(), emClientSecret.trim() || undefined);
      // Open the consent page: Tauri opener on desktop, new tab on web.
      try {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(auth_url);
      } catch {
        window.open(auth_url, '_blank', 'noopener');
      }
      // Poll until the loopback catcher completes the dance.
      const deadline = Date.now() + 5 * 60 * 1000;
      // eslint-disable-next-line no-constant-condition
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const st = await pollEmailOAuth(flow_id);
        if (st.status === 'done') {
          setEmFlowId(flow_id);
          setEmSignedInAs(st.email ?? null);
          if (st.email && !emUser.trim()) setEmUser(st.email);
          setEmMsg(`Signed in${st.email ? ` as ${st.email}` : ''}. Now add the account.`);
          return;
        }
        if (st.status === 'error') {
          setEmMsg(st.error ?? 'Sign-in failed.');
          return;
        }
      }
      setEmMsg('Sign-in timed out — try again.');
    } catch (e) {
      setEmMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setEmBusy(false);
    }
  };
  const emTest = async () => {
    if (emAuth === 'oauth' || !emHost.trim() || !emUser.trim() || !emPass || emBusy) return;
    setEmBusy(true);
    setEmMsg('Testing…');
    try {
      const r = await testEmailAccount(emBody());
      setEmMsg(r.ok ? `Connected — folders: ${r.folders.join(', ')}` : 'Failed to connect.');
    } catch (e) {
      setEmMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setEmBusy(false);
    }
  };
  const emAdd = async () => {
    if (!emReady || emBusy) return;
    setEmBusy(true);
    setEmMsg(null);
    try {
      await createEmailAccount(emBody());
      setEmLabel('');
      setEmPass('');
      setEmFlowId(null);
      setEmSignedInAs(null);
      setEmClientSecret('');
      await emRefresh();
      setEmMsg('Account added — it syncs every few minutes (or Sync now).');
    } catch (e) {
      setEmMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setEmBusy(false);
    }
  };
  const emSync = async (id: number) => {
    setEmBusy(true);
    setEmMsg(null);
    try {
      const r = await syncEmailAccount(id);
      setEmMsg(`Synced: ${r.new_messages} new message(s) across ${r.folders} folder(s)${r.errors.length ? `, ${r.errors.length} failed (${r.errors[0]}${r.errors.length > 1 ? ', …' : ''})` : ''}.`);
      await emRefresh();
    } catch (e) {
      setEmMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setEmBusy(false);
    }
  };
  const emToggle = async (a: EmailAccount) => {
    try {
      await updateEmailAccount(a.id, { enabled: !a.enabled });
      await emRefresh();
    } catch (e) {
      setEmMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const emDelete = async (a: EmailAccount) => {
    if (!(await confirmDialog(`Remove "${a.label}" (${a.username})? Synced threads and messages are deleted from Ganban; your mailbox is untouched.`))) return;
    try {
      await deleteEmailAccount(a.id);
      await emRefresh();
    } catch (e) {
      setEmMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const [tz, setTz] = useState(getTimezone());

  // Plug-ins
  const [giphyKey, setGiphyKeyState] = useState('');
  const [giphyMsg, setGiphyMsg] = useState<string | null>(null);

  // AI Engines: ragrat + Ollama, stored in DB app_settings.
  const [ragratUrl, setRagratUrl] = useState('');
  const [ragratToken, setRagratToken] = useState('');
  const [ollamaUrl, setOllamaUrl] = useState('http://127.0.0.1:11434');
  const [ragratMsg, setRagratMsg] = useState<string | null>(null);
  const [ollamaMsg, setOllamaMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  // Tailscale auto-share (optional, owner-only): credential + which device is
  // this server. Stored host-side (app_settings); the secret never leaves it.
  const [tsClientId, setTsClientId] = useState('');
  const [tsClientSecret, setTsClientSecret] = useState('');
  const [tsToken, setTsToken] = useState('');
  const [tsTailnet, setTsTailnet] = useState('');
  const [tsDeviceId, setTsDeviceId] = useState('');
  const [tsDevices, setTsDevices] = useState<TailscaleDevice[]>([]);
  const [tsMsg, setTsMsg] = useState<string | null>(null);
  const [tsChecking, setTsChecking] = useState(false);
  // Write-path verdict from Check: set when the credential lists devices but
  // can't mint a share (an OAuth client) — surfaced prominently so the misconfig
  // doesn't pass silently and only fail later at invite time.
  const [tsShareWarn, setTsShareWarn] = useState<string | null>(null);
  // When the access token runs out (Check reports it). Tailscale caps personal
  // tokens at 90 days — without this the first sign was a 401 at invite time.
  const [tsExpiry, setTsExpiry] = useState<TokenExpiry | null>(null);

  // Feedback / tickets (host-served): file a bug or feature request; the owner
  // sees all and can triage status, everyone else sees their own.
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketKind, setTicketKind] = useState<'bug' | 'feature'>('bug');
  const [ticketTitle, setTicketTitle] = useState('');
  const [ticketBody, setTicketBody] = useState('');
  const [ticketBusy, setTicketBusy] = useState(false);
  const [ticketMsg, setTicketMsg] = useState<string | null>(null);
  const [amOwner, setAmOwner] = useState(false);

  // AI Engine (desktop-only): launch + supervise Ollama + ragrat locally.
  const [engine, setEngine] = useState<AiEngineStatus | null>(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [engineMsg, setEngineMsg] = useState<string | null>(null);
  const [ragratPath, setRagratPath] = useState('');

  // Models (AI): chat model + params, model pulling, embedding model.
  const [models, setModels] = useState<string[]>([]);
  const [chatModel, setChatModel] = useState('');
  const [chatSystemPrompt, setChatSystemPrompt] = useState('');
  const [temperature, setTemperature] = useState('0.7');
  const [maxTokens, setMaxTokens] = useState('');
  const [modelMsg, setModelMsg] = useState<string | null>(null);
  const [pullName, setPullName] = useState('');
  const [pullPct, setPullPct] = useState<number | null>(null);
  const [pulling, setPulling] = useState(false);
  const [embedModel, setEmbedModel] = useState('nomic-embed-text');
  const [visionModel, setVisionModel] = useState('');
  const [visionEndpoint, setVisionEndpoint] = useState('');
  const [visionMsg, setVisionMsg] = useState<string | null>(null);
  const [visionModels, setVisionModels] = useState<string[]>([]); // filled by Check — pick, don't guess
  const [embedInfo, setEmbedInfo] = useState<{ dimensions: number; endpoint: string } | null>(null);
  const [embedMsg, setEmbedMsg] = useState<string | null>(null);
  const [reembedding, setReembedding] = useState(false);

  // Personalities (model profiles)
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<number | null>(null);
  const [secretaryProfileId, setSecretaryProfileId] = useState<number | null>(null);
  const [toolProfileId, setToolProfileId] = useState<number | null>(null);
  const [librarianProfileId, setLibrarianProfileId] = useState<number | null>(null);
  // structure_toc protocol: runner (ollama/pi) + model. The first agent-task
  // class — PDF Studio's auto-build ToC button. Default = ollama (free).
  const [tocRunner, setTocRunner] = useState<'ollama' | 'pi'>('ollama');
  const [tocProfileId, setTocProfileId] = useState<number | null>(null);
  const [tocPiModel, setTocPiModel] = useState<string>('');
  const [piBinaryPath, setPiBinaryPath] = useState<string>('');
  const [tocMsg, setTocMsg] = useState<string | null>(null);
  // Bumped after a routing save so the ProtocolsPanel remounts + reloads
  // (each save creates an immutable new version it should show).
  const [protoNonce, setProtoNonce] = useState(0);
  const [pName, setPName] = useState('');
  const [pModel, setPModel] = useState('');
  const [pPrompt, setPPrompt] = useState('');
  const [pTemp, setPTemp] = useState('0.7');
  const [pMax, setPMax] = useState('');
  const [pEditId, setPEditId] = useState<number | null>(null);
  const [pAvatar, setPAvatar] = useState<string | null>(null);
  const [pMeta, setPMeta] = useState<ModelMeta | null>(null);
  const [pEndpoint, setPEndpoint] = useState('');
  const [pFallback, setPFallback] = useState('');
  // The remote engine's catalog after a successful Test — replaces the local
  // list in the model dropdown while an endpoint is set.
  const [pRemoteModels, setPRemoteModels] = useState<string[] | null>(null);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);

  // Data & Storage
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [storagePaths, setStoragePaths] = useState<StoragePaths | null>(null);
  const [defaultQuotaMb, setDefaultQuotaMb] = useState(String(DEFAULT_QUOTA_MB));
  const [projects, setProjects] = useState<Project[]>([]);
  const [selProject, setSelProject] = useState<number>(0);
  const [projQuotaMb, setProjQuotaMb] = useState('');
  const [storageMsg, setStorageMsg] = useState<string | null>(null);
  // Client-side: warn before linking a local file in a description (uploading
  // it to the server makes it visible to everyone with task access). Mirror of
  // the TaskEditor's localStorage flag.
  const [warnLocalLink, setWarnLocalLink] = useState(true);
  const [tomorrowPolicy, setTomorrowPolicyState] = useState<TomorrowPolicy>(() => getTomorrowPolicy());
  const [dayOfReminders, setDayOfRemindersState] = useState(() => getDayOfEnabled());

  useEffect(() => {
    if (!isOpen) return;
    // The GIPHY key lives on the HOST (app_setting, injected by the /giphy
    // proxy so members never see it). Prefill from the legacy per-device
    // localStorage copy so an already-entered key is one Save away.
    getAppSetting('giphy_api_key')
      .then((v) => setGiphyKeyState(v ?? getGiphyKey() ?? ''))
      .catch(() => setGiphyKeyState(getGiphyKey() ?? ''));
    getAppSetting('default_storage_quota_bytes')
      .then((v) => setDefaultQuotaMb(v ? String(Math.round(Number(v) / 1024 / 1024)) : String(DEFAULT_QUOTA_MB)))
      .catch(() => {});
    getProjects()
      .then((ps) => setProjects(ps.filter((p) => !p.archived)))
      .catch(() => {});
    getAppSetting('ragrat_connection')
      .then((v) => {
        if (!v) return;
        try {
          const c = JSON.parse(v);
          setRagratUrl(c.url ?? '');
          setRagratToken(c.token ?? '');
        } catch { /* ignore */ }
      })
      .catch(() => {});
    getAppSetting('ollama_connection')
      .then((v) => {
        if (!v) return;
        try {
          setOllamaUrl(JSON.parse(v).base_url ?? 'http://127.0.0.1:11434');
        } catch { /* ignore */ }
      })
      .catch(() => {});
    getAppSetting('chat_profile')
      .then((v) => {
        if (!v) return;
        try {
          const c = JSON.parse(v);
          if (c.model) setChatModel(c.model);
          if (c.temperature != null) setTemperature(String(c.temperature));
          if (c.max_tokens != null) setMaxTokens(String(c.max_tokens));
          if (c.system_prompt) setChatSystemPrompt(c.system_prompt);
        } catch { /* ignore */ }
      })
      .catch(() => {});
    getAppSetting('rag_embedding')
      .then((v) => {
        if (!v) return;
        try {
          const c = JSON.parse(v);
          if (c.model) setEmbedModel(c.model);
        } catch { /* ignore */ }
      })
      .catch(() => {});
    getAppSetting('rag_vision')
      .then((v) => {
        if (!v) return;
        try {
          const c = JSON.parse(v);
          if (c.model) setVisionModel(c.model);
          if (c.endpoint) setVisionEndpoint(c.endpoint);
        } catch { /* ignore */ }
      })
      .catch(() => {});
    getAppSetting('ragrat_binary_path').then((v) => v && setRagratPath(v)).catch(() => {});
    getAppSetting('tailscale_api')
      .then((v) => {
        if (!v) return;
        try {
          const c = JSON.parse(v);
          if (c.access_token) setTsToken(c.access_token);
          if (c.oauth?.client_id) setTsClientId(c.oauth.client_id);
          if (c.oauth?.client_secret) setTsClientSecret(c.oauth.client_secret);
          if (c.tailnet) setTsTailnet(c.tailnet);
        } catch { /* ignore */ }
      })
      .catch(() => {});
    getAppSetting('tailscale_device_id').then((v) => v && setTsDeviceId(v)).catch(() => {});
  }, [isOpen]);

  // List the host's models when the Models section opens.
  const loadModels = async () => {
    try {
      const r = await testAiConnection('ollama', { base_url: ollamaUrl.trim() });
      if (r.ok && r.models) setModels(r.models);
      else setModelMsg(r.error ?? 'Could not list models — check the Ollama connection.');
    } catch (e) {
      setModelMsg(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    if (isOpen && (section === 'models' || section === 'personalities')) loadModels();
    if (isOpen && section === 'personalities') loadProfiles();
    if (isOpen && section === 'data' && isTauri()) getStoragePaths().then(setStoragePaths).catch(() => setStoragePaths(null));
    if (isOpen && section === 'data') setWarnLocalLink(localStorage.getItem('ganban:warn-local-file-link') !== '0');
    if (isOpen && section === 'connections') refreshEngine();
    if (isOpen && section === 'feedback') void loadTickets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, section]);

  const loadTickets = async () => {
    try {
      const [list, me] = await Promise.all([
        listTickets(),
        hasDaemon() ? getMe().then((m) => !!m.user.is_owner).catch(() => false) : Promise.resolve(true),
      ]);
      setTickets(list);
      setAmOwner(me);
    } catch (e) {
      setTicketMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const submitTicket = async () => {
    if (!ticketTitle.trim()) return;
    setTicketBusy(true);
    setTicketMsg(null);
    try {
      await createTicket(ticketKind, ticketTitle.trim(), ticketBody.trim() || undefined);
      setTicketTitle('');
      setTicketBody('');
      setTicketMsg('Thanks — your ticket was filed.');
      await loadTickets();
    } catch (e) {
      setTicketMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setTicketBusy(false);
    }
  };

  const toggleTicket = async (t: Ticket) => {
    const next = t.status === 'open' ? 'closed' : 'open';
    try {
      await setTicketStatus(t.id, next);
      await loadTickets();
    } catch (e) {
      setTicketMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const refreshEngine = async () => {
    try {
      setEngine(await aiEngineStatus());
    } catch (e) {
      setEngineMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const startEngines = async () => {
    setEngineBusy(true);
    setEngineMsg('Starting engines…');
    try {
      // 1. Spawn Ollama + ragrat and write their connection settings.
      const r = await aiEngineStart();
      setOllamaUrl(r.ollama_url);
      setRagratUrl(r.ragrat_url);
      // 2. Ensure the Ganban host daemon is running + the app is pointed at it,
      //    so chat / test / reload have a daemon to talk to (one-click setup).
      try {
        const st = await daemonStatus();
        let port = st.port ?? undefined;
        if (!st.running) {
          // Loopback: engines need A daemon, not an exposed one — going wide
          // here would also persist host mode (Start remembers) from a button
          // that never promised network exposure.
          port = (await daemonStart(undefined, true)).port ?? undefined;
        }
        if (port) setDaemonBaseUrl(`http://127.0.0.1:${port}`);
      } catch {
        /* hosting unavailable (e.g. not a desktop host) — engines still set */
      }
      // 3. Apply the new config to the (now-running, connected) daemon.
      await reloadAi().catch(() => {});
      await refreshEngine();
      // A ragrat we can't manage may be ignoring the workers setting — that
      // beats "Engines running" as the thing the owner needs to know.
      setEngineMsg(r.warning ?? 'Engines running, daemon hosting, connected.');
    } catch (e) {
      setEngineMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setEngineBusy(false);
    }
  };
  const stopEngines = async () => {
    setEngineBusy(true);
    try {
      await aiEngineStop();
      await refreshEngine();
      setEngineMsg('Stopped the engines Ganban started.');
    } catch (e) {
      setEngineMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setEngineBusy(false);
    }
  };
  // Stop an EXTERNAL ragrat squatting on the configured port — the one Ganban
  // can't supervise (so Stop is disabled) and which keeps a workers change from
  // ever applying. Soft by default (the backend SIGTERMs first), but confirm
  // since we're signalling a process we didn't launch.
  const reclaimRagrat = async () => {
    if (!(await confirmDialog(
      'Stop the external ragrat that is using this port?\n\nGanban will ask it to shut down (and force it only if it ignores that). Click Start engines afterwards to launch a managed one with your current settings.'
    ))) return;
    setEngineBusy(true);
    setEngineMsg('Stopping the external ragrat…');
    try {
      setEngineMsg(await aiEngineReclaimRagrat());
      await refreshEngine();
    } catch (e) {
      setEngineMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setEngineBusy(false);
    }
  };
  const saveRagratPath = async () => {
    await setAppSetting('ragrat_binary_path', ragratPath.trim());
    await refreshEngine();
    setEngineMsg(ragratPath.trim() ? 'ragrat path saved.' : 'ragrat path cleared.');
  };

  const loadProfiles = async () => {
    try {
      const r = await listProfiles();
      setProfiles(r.profiles);
      setActiveProfileId(r.active_id);
      setSecretaryProfileId(r.secretary_id ?? null);
      setToolProfileId(r.routing?.tools ?? null);
      setLibrarianProfileId(r.routing?.librarian ?? null);
      // structure_toc protocol: legacy int = ollama; object = { runner, profile_id, model }.
      const toc = r.routing?.structure_toc as { runner?: string; profile_id?: number; model?: string } | number | undefined;
      if (typeof toc === 'number') {
        setTocRunner('ollama'); setTocProfileId(toc); setTocPiModel('');
      } else if (toc && typeof toc === 'object') {
        setTocRunner(toc.runner === 'pi' ? 'pi' : 'ollama');
        setTocProfileId(toc.profile_id ?? null);
        setTocPiModel(toc.model ?? '');
      } else {
        setTocRunner('ollama'); setTocProfileId(null); setTocPiModel('');
      }
      // pi binary path (host setting) — non-fatal: if this fails (e.g. not
      // authenticated as owner over HTTP), don't kill the whole profile load.
      try {
        const piPath = await getAppSetting('pi_binary_path');
        setPiBinaryPath(piPath ?? '');
      } catch { setPiBinaryPath(''); }
    } catch (e) {
      setProfileMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const editProfile = (p: ModelProfile) => {
    setPEditId(p.id);
    setPName(p.name);
    setPModel(p.model);
    setPPrompt(p.system_prompt ?? '');
    setPTemp(p.temperature != null ? String(p.temperature) : '');
    setPMax(p.max_tokens != null ? String(p.max_tokens) : '');
    setPAvatar(p.avatar ?? null);
    setPEndpoint(p.endpoint ?? '');
    setPFallback(p.fallback_note ?? '');
    setPRemoteModels(null);
    setPMeta(parseModelMeta(p.model_meta));
    setProfileMsg(null);
  };
  const newProfile = () => {
    setPEditId(null);
    setPName('');
    setPModel(chatModel || models[0] || '');
    setPPrompt('');
    setPTemp('0.7');
    setPMax('');
    setPAvatar(null);
    setPMeta(null);
    setProfileMsg(null);
  };
  /** Read a picked image into a (size-capped) data-URL for the avatar. */
  const onAvatarPick = (file: File | null) => {
    if (!file) return;
    if (file.size > 512 * 1024) {
      setProfileMsg('Image is too large — pick one under 512 KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPAvatar(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(file);
  };
  // Pull live capabilities for the chosen model so the vCard fills in before save.
  useEffect(() => {
    if (section !== 'personalities' || !pModel.trim()) {
      return;
    }
    let cancelled = false;
    getModelInfo(pModel.trim())
      .then((m) => !cancelled && setPMeta(m))
      .catch(() => {/* engine down / model not pulled — leave any cached meta */});
    return () => {
      cancelled = true;
    };
  }, [pModel, section]);
  const saveProfile = async () => {
    if (!pName.trim() || !pModel.trim()) {
      setProfileMsg('Name and model are required.');
      return;
    }
    try {
      const saved = await upsertProfile({
        id: pEditId ?? undefined,
        name: pName.trim(),
        model: pModel.trim(),
        system_prompt: pPrompt.trim() || undefined,
        temperature: pTemp.trim() ? Number(pTemp) : undefined,
        max_tokens: pMax.trim() ? Number(pMax) : undefined,
        avatar: pAvatar,
        endpoint: pEndpoint.trim() || undefined,
        fallback_note: pFallback.trim() || undefined,
      });
      setProfileMsg('Saved.');
      setPEditId(saved.id);
      setPMeta(parseModelMeta(saved.model_meta) ?? pMeta);
      await loadProfiles();
    } catch (e) {
      setProfileMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const activateProfile = async (id: number) => {
    try {
      await setActiveProfile(id);
      setActiveProfileId(id);
    } catch (e) {
      setProfileMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const designateSecretary = async (id: number | null) => {
    try {
      await setSecretaryProfile(id);
      setSecretaryProfileId(id);
    } catch (e) {
      setProfileMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const designateRouting = async (cls: 'tools' | 'librarian', id: number | null) => {
    try {
      await setRoutingProfile(cls, id);
      if (cls === 'tools') setToolProfileId(id);
      else setLibrarianProfileId(id);
    } catch (e) {
      setProfileMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const removeProfile = async (id: number) => {
    try {
      await deleteProfile(id);
      if (pEditId === id) newProfile();
      await loadProfiles();
    } catch (e) {
      setProfileMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const saveChatModel = async () => {
    try {
      const profile: Record<string, unknown> = { model: chatModel.trim() };
      if (temperature.trim()) profile.temperature = Number(temperature);
      if (maxTokens.trim()) profile.max_tokens = Number(maxTokens);
      if (chatSystemPrompt) profile.system_prompt = chatSystemPrompt; // preserved (M5 edits it)
      await setAppSetting('chat_profile', JSON.stringify(profile));
      setModelMsg('Saved.');
    } catch (e) {
      setModelMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const doPull = async () => {
    if (!pullName.trim()) return;
    setPulling(true);
    setPullPct(null);
    setModelMsg(null);
    try {
      await pullModel(pullName.trim(), (p) => {
        if (p.total) setPullPct(Math.round((100 * (p.completed ?? 0)) / p.total));
      });
      setModelMsg(`Pulled ${pullName.trim()}.`);
      setPullName('');
      await loadModels();
    } catch (e) {
      setModelMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setPulling(false);
      setPullPct(null);
    }
  };
  const doEmbedCheck = async () => {
    setEmbedMsg(null);
    setEmbedInfo(null);
    try {
      const r = await embedTest(embedModel.trim());
      if (r.ok && r.dimensions && r.endpoint) {
        setEmbedInfo({ dimensions: r.dimensions, endpoint: r.endpoint });
        setEmbedMsg(`OK — ${r.dimensions} dimensions.`);
      } else {
        setEmbedMsg(`Failed: ${r.error ?? 'is this an embedding model?'}`);
      }
    } catch (e) {
      setEmbedMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const saveEmbedAndReindex = async () => {
    if (!embedInfo) return;
    setReembedding(true);
    setEmbedMsg(null);
    try {
      await setAppSetting(
        'rag_embedding',
        JSON.stringify({ endpoint: embedInfo.endpoint, model: embedModel.trim(), dimensions: embedInfo.dimensions })
      );
      const r = await reembedAll();
      setEmbedMsg(`Saved — re-indexed ${r.reindexed} project(s).`);
    } catch (e) {
      setEmbedMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setReembedding(false);
    }
  };

  // When a project is chosen, seed its quota field from its current allocation.
  useEffect(() => {
    const p = projects.find((x) => x.id === selProject);
    if (p) setProjQuotaMb(String(Math.round((p.storage_quota_bytes ?? 0) / 1024 / 1024)));
  }, [selProject, projects]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Reveal a local folder in the OS file manager (desktop only).
  const openFolder = async (path: string) => {
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener');
      await openPath(path);
    } catch (e) {
      setStorageMsg(`Couldn't open folder: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleExportDatabase = async () => {
    try {
      setIsExporting(true);
      const filePath = await save({ filters: [{ name: 'Database', extensions: ['db'] }], defaultPath: 'ganban-backup.db' });
      if (filePath) {
        await exportDatabase(filePath);
        setStorageMsg('Database exported.');
      }
    } catch (error) {
      setStorageMsg(`Export failed: ${error}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleImportDatabase = async () => {
    if (!await confirmDialog('WARNING: Importing replaces your current data (an automatic backup is made first). Continue?')) return;
    try {
      setIsImporting(true);
      const filePath = await open({ filters: [{ name: 'Database', extensions: ['db'] }], multiple: false });
      if (filePath) {
        await importDatabase(filePath as string);
        alert('Database imported. Restart to see the changes.');
        window.location.reload();
      }
    } catch (error) {
      setStorageMsg(`Import failed: ${error}`);
    } finally {
      setIsImporting(false);
    }
  };

  const saveDefaultQuota = async () => {
    const mb = Number(defaultQuotaMb);
    if (!Number.isFinite(mb) || mb < 0) return setStorageMsg('Enter a number of MB.');
    try {
      await setAppSetting('default_storage_quota_bytes', String(Math.round(mb * 1024 * 1024)));
      setStorageMsg('Default storage saved (applies to new projects).');
    } catch (e) {
      setStorageMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const saveProjectQuota = async () => {
    if (!selProject) return;
    const mb = Number(projQuotaMb);
    if (!Number.isFinite(mb) || mb < 0) return setStorageMsg('Enter a number of MB.');
    try {
      await setProjectQuota(selProject, Math.round(mb * 1024 * 1024));
      const ps = (await getProjects()).filter((p) => !p.archived);
      setProjects(ps);
      setStorageMsg('Project allocation saved.');
    } catch (e) {
      setStorageMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const testGiphy = async () => {
    setGiphyMsg('Testing…');
    try {
      // Validate the typed key WITHOUT persisting it (don't save a bad key).
      const gifs = await searchGifs('hello', 1, giphyKey);
      setGiphyMsg(gifs.length ? 'Key works ✓ — click Save to keep it.' : 'Connected, but no results.');
    } catch (e) {
      setGiphyMsg(e instanceof Error ? e.message : String(e));
    }
  };

  // AI connections target the HOST's settings. They're saved via the owner-only
  // app-setting path (host DB when online / when this machine is the host) and
  // tested server-side (the host reaches its own loopback engines).
  const saveRagrat = async () => {
    try {
      await setAppSetting('ragrat_connection', JSON.stringify({ url: ragratUrl.trim(), token: ragratToken.trim() }));
      await reloadAi();
      setRagratMsg('Saved and applied.');
    } catch (e) {
      setRagratMsg(e instanceof Error ? e.message : String(e));
    }
  };

  // Tailscale auto-share: persist the credential (host-side; never leaves it),
  // then Check lists the tailnet's devices so the owner can mark which one is
  // this server. With both set, every new invite carries a one-time share.
  const saveTailscale = async () => {
    const cfg: Record<string, unknown> = {};
    if (tsToken.trim()) cfg.access_token = tsToken.trim();
    if (tsClientId.trim() && tsClientSecret.trim()) cfg.oauth = { client_id: tsClientId.trim(), client_secret: tsClientSecret.trim() };
    if (tsTailnet.trim()) cfg.tailnet = tsTailnet.trim();
    const configured = Object.keys(cfg).length > 0;
    await setAppSetting('tailscale_api', configured ? JSON.stringify(cfg) : '');
    return configured;
  };

  const handleSaveTailscale = async () => {
    try {
      const configured = await saveTailscale();
      setTsShareWarn(null); // creds changed — stale verdict no longer applies
      setTsMsg(configured ? 'Saved on the host. Click Check to pick this server.' : 'Cleared — invites no longer carry a Tailscale share.');
    } catch (e) {
      setTsMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const checkTailscale = async () => {
    setTsChecking(true);
    setTsMsg(null);
    setTsShareWarn(null);
    try {
      await saveTailscale(); // persist the latest creds before validating them
      const r = await tailscaleCheck();
      setTsDevices(r.devices);
      // Only an explicit `false` is a warning — `undefined` means an older host
      // that didn't report the write verdict, so don't cry wolf.
      const canShare = r.share_capable !== false;
      setTsShareWarn(canShare ? null : (r.share_detail ?? "This credential can list devices but can't create a device share."));
      setTsExpiry(r.token_expiry ?? null);
      const where = `on tailnet "${r.tailnet}"`;
      setTsMsg(
        !canShare
          ? `Lists ${r.devices.length} device${r.devices.length === 1 ? '' : 's'} ${where}, but this credential can't issue shares — see below.`
          : r.devices.length
            ? `Credential OK — ${r.devices.length} device${r.devices.length === 1 ? '' : 's'} ${where}. Pick this server below.`
            : `Credential OK, but no devices found ${where}.`
      );
    } catch (e) {
      setTsMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setTsChecking(false);
    }
  };

  const pickTailscaleDevice = async (id: string) => {
    setTsDeviceId(id);
    try {
      await setAppSetting('tailscale_device_id', id);
      // Persist the device's MagicDNS FQDN (its API `name`, sans trailing dot) so
      // the daemon leads invites with a stable hostname — it survives the host's
      // tailnet IP changing and is the form a cross-tailnet shared device resolves
      // by. Clearing the pick clears it; if the device isn't in the current list
      // (a saved id, no Check yet) leave any existing value rather than blank it.
      const name = tsDevices.find((d) => d.id === id)?.name?.replace(/\.$/, '');
      if (!id) await setAppSetting('tailscale_device_fqdn', '');
      else if (name) await setAppSetting('tailscale_device_fqdn', name);
      setTsMsg(id ? 'This machine is set as the shared server — new invites include a one-click Tailscale share.' : 'Server device cleared.');
    } catch (e) {
      setTsMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const testRagrat = async () => {
    setTesting('ragrat');
    setRagratMsg(null);
    try {
      const r = await testAiConnection('ragrat', { url: ragratUrl.trim(), token: ragratToken.trim() });
      setRagratMsg(r.ok ? `Connected${r.version ? ` (v${r.version})` : ''}.` : `Failed: ${r.error ?? 'unreachable'}`);
    } catch (e) {
      setRagratMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(null);
    }
  };
  const saveOllama = async () => {
    try {
      await setAppSetting('ollama_connection', JSON.stringify({ base_url: ollamaUrl.trim() }));
      await reloadAi();
      setOllamaMsg('Saved and applied.');
    } catch (e) {
      setOllamaMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const testOllama = async () => {
    setTesting('ollama');
    setOllamaMsg(null);
    try {
      const r = await testAiConnection('ollama', { base_url: ollamaUrl.trim() });
      setOllamaMsg(r.ok ? `Connected — ${r.models?.length ?? 0} model(s) available.` : `Failed: ${r.error ?? 'unreachable'}`);
    } catch (e) {
      setOllamaMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(null);
    }
  };

/** Windows puts venv entry points in Scripts\, not bin/ — path hints must
 * follow the platform or they send people hunting a folder that can't exist. */
function isWindowsHost(): boolean {
  return typeof navigator !== "undefined" && /win/i.test(navigator.userAgent) && !/darwin|mac/i.test(navigator.userAgent);
}

  const input = 'g-field';
  const H = ({ children }: { children: React.ReactNode }) => <DecoHeading as="h3">{children}</DecoHeading>;

  const renderSection = () => {
    switch (section) {
      case 'design':
        return (
          <div className="space-y-5">
            {/* Browser clients choose their shell: the heuristic (pointer +
                viewport) is right most of the time, but a tablet user may
                want the full desktop UI — or a laptop user the touch one. */}
            {isWebClient() && (
              <div>
                <H>Interface</H>
                <div className="g-seg">
                  {([
                    { key: null, label: 'Automatic' },
                    { key: 'desktop' as Shell, label: 'Desktop' },
                    { key: 'touch' as Shell, label: 'Touch' },
                  ]).map((opt) => (
                    <button
                      key={opt.label}
                      onClick={() => { setShellOverride(opt.key); window.location.reload(); }}
                      className={`g-chip ${shellOverride() === opt.key ? 'g-on' : ''}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-subtext-0 mt-2">Reloads the page.</p>
              </div>
            )}
            <div>
            <H>Design</H>
            {/* One swatch card per theme: its base, accent and gold. The
                current theme is ringed in gold. */}
            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
              {Object.entries(themes).map(([key, theme]) => {
                const on = currentTheme === key;
                return (
                  <button
                    key={key}
                    onClick={() => setTheme(key)}
                    aria-pressed={on}
                    className={`flex flex-col gap-3 px-4 py-4 text-left rounded border transition-colors ${
                      on ? 'bg-mantle border-gold ring-1 ring-gold ring-offset-2 ring-offset-base' : 'bg-mantle border-surface-0 hover:border-surface-1'
                    }`}
                  >
                    <span className={`flex items-center justify-between gap-2 text-sm font-semibold ${on ? 'text-gold' : 'text-text'}`}>
                      <span className="truncate">{theme.name}</span>
                      {on && <span className="g-gem" aria-hidden="true" />}
                    </span>
                    <span className="flex gap-1.5" aria-hidden="true">
                      {([theme.colors.base, theme.colors.primary, theme.colors.gold] as const).map((c, i) => (
                        <span
                          key={i}
                          className="w-[22px] h-[22px] rounded"
                          style={{ backgroundColor: c, boxShadow: `inset 0 0 0 1px ${theme.colors.surface1}` }}
                        />
                      ))}
                    </span>
                  </button>
                );
              })}
            </div>
            </div>
            <div>
              <H>Clock</H>
              <div className="g-card p-5 space-y-2">
                <label className="block text-sm font-medium text-text">Time zone</label>
                <p className="text-xs text-subtext-0">Sets the time and zone shown in the top-bar clock.</p>
                <select value={tz} onChange={(e) => { setTz(e.target.value); setTimezone(e.target.value); }} className={input}>
                  <option value="">System default ({resolvedTimezone()})</option>
                  {timezoneList().map((z) => (
                    <option key={z} value={z}>{z}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        );

      case 'profile':
        return (
          <div className="space-y-6">
            <div>
              <H>Profile</H>
              <ProfileEditor userId={currentUserId} />
            </div>
            {/* Hosted clients (browser, online desktop) authenticate by device
                token: this is where a member sees their devices and brings
                the account to another one. The host itself pairs from Sync. */}
            {isHostedClient() && (
              <div>
                <H>Your devices</H>
                <p className="text-xs text-subtext-0 mb-3">
                  Each browser or app you sign in from is a device on your account. Pair another device to use Ganban there as you —
                  no password, no second account.
                </p>
                <YourDevices onSignedOutHere={() => { setDeviceToken(null); window.location.reload(); }} />
              </div>
            )}
          </div>
        );

      case 'plugins':
        return (
          <div className="space-y-4">
            <H>Plug-ins</H>
            <div className="g-card p-5 space-y-2">
              <div className="font-medium text-text">GIPHY</div>
              <p className="text-sm text-subtext-0">A free GIPHY API key enables GIF search in comments for <span className="text-text">every member</span> — it's stored on the host and injected server-side, so phones never need their own key (giphy.com → Developers → Create an App).</p>
              <input value={giphyKey} onChange={(e) => setGiphyKeyState(e.target.value)} placeholder="GIPHY API key" className={input} />
              <div className="flex gap-2 items-center">
                <button
                  onClick={() => {
                    setAppSetting('giphy_api_key', giphyKey.trim())
                      .then(() => {
                        setGiphyKey(''); // retire the legacy per-device copy
                        setGiphyMsg(giphyKey.trim() ? 'Saved on the host — GIF search now works for every member.' : 'Cleared.');
                      })
                      .catch((e) => setGiphyMsg(e instanceof Error ? e.message : String(e)));
                  }}
                  className="g-btn g-btn-pri"
                >
                  Save
                </button>
                <button onClick={testGiphy} disabled={!giphyKey.trim()} className="g-btn g-btn-ghost">
                  Test
                </button>
                {giphyMsg && <span className="text-sm text-subtext-1">{giphyMsg}</span>}
              </div>
            </div>

            {/* Tab modules' owner cards (src/tabs/modules.ts) */}
            {TAB_MODULES.flatMap((m) => m.settings ?? []).map((Card, i) => (
              <Suspense key={i} fallback={null}>
                <Card inputClass={input} />
              </Suspense>
            ))}

            {/* Folder sync — locally-mirrored cloud folders → project files */}
            <div className="g-card p-5 space-y-3">
              <div className="font-medium text-text">Folder sync</div>
              <p className="text-sm text-subtext-0">
                Import files from any local folder into a project — point it at a folder your cloud
                client already keeps mirrored (OneDrive, Nextcloud, Google Drive…) and Ganban pulls
                matching files in every few minutes. Imported files appear in the project's Files tab
                and join its knowledge base; edits at the source update the same file in place.
                One-way import: deletions are never propagated.
              </p>
              {!hasDaemon() ? (
                <p className="text-xs text-subtext-0">Connect to a host to manage folder sync.</p>
              ) : (
                <>
                  {sfList.map((f) => (
                    <div key={f.id} className="g-inset px-3 py-2 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-text truncate flex-1" title={f.path}>
                          {sfProjects.find((p) => p.id === f.project_id)?.name ?? `Project #${f.project_id}`} ← <span className="font-mono text-xs">{f.path}</span>
                        </span>
                        <button onClick={() => void sfRun(f.id)} disabled={sfBusy} className="g-btn g-btn-ghost g-btn-sm shrink-0">
                          Sync now
                        </button>
                        <button onClick={() => void sfToggle(f)} className={`g-chip shrink-0 ${f.enabled ? 'g-on' : ''}`}>
                          {f.enabled ? 'On' : 'Off'}
                        </button>
                        <button onClick={() => void sfDelete(f)} className="g-btn g-btn-danger g-btn-sm shrink-0">
                          ✕
                        </button>
                      </div>
                      <div className="text-xs text-subtext-0">
                        {f.include_ext ? `types: ${f.include_ext}` : 'all types'}
                        {f.max_bytes > 0 ? ` · ≤ ${Math.round(f.max_bytes / (1024 * 1024))} MB/file` : ''}
                        {f.last_result ? ` · last scan: ${f.last_result}` : ' · not scanned yet'}
                      </div>
                    </div>
                  ))}

                  <div className="pt-1 space-y-2">
                    <div className="flex gap-2">
                      <select value={sfProjectId} onChange={(e) => setSfProjectId(e.target.value ? Number(e.target.value) : '')} className={`${input} flex-1`}>
                        <option value="">Into project…</option>
                        {sfProjects.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex gap-2">
                      <input value={sfPath} onChange={(e) => setSfPath(e.target.value)} placeholder="/Users/you/OneDrive/Uni/SMM283" className={`${input} flex-1 font-mono text-xs`} />
                      {isTauri() && (
                        <button onClick={() => void sfBrowse()} className="g-btn g-btn-ghost shrink-0">
                          Browse…
                        </button>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <input value={sfExt} onChange={(e) => setSfExt(e.target.value)} placeholder="file types, e.g. pdf, docx, md (empty = all)" className={`${input} flex-1`} />
                      <input value={sfMaxMb} onChange={(e) => setSfMaxMb(e.target.value)} placeholder="max MB/file" className={`${input} w-32`} />
                    </div>
                    <button onClick={() => void sfAdd()} disabled={!sfProjectId || !sfPath.trim() || sfBusy} className="g-btn g-btn-pri">
                      {sfBusy ? 'Working…' : 'Add synced folder'}
                    </button>
                    {sfMsg && <p className="text-xs text-subtext-1">{sfMsg}</p>}
                  </div>
                </>
              )}
            </div>

            {/* Email accounts — the owner's IMAP mailboxes → linkable threads */}
            <div className="g-card p-5 space-y-3">
              <div className="font-medium text-text">Email accounts</div>
              <p className="text-sm text-subtext-0">
                Each member connects their own mailbox — your unlinked mail is visible only to you, and
                linking a thread to a project shares it with that project. Ganban is an IMAP client and
                can never send: agent drafts land in your own Drafts folder.
              </p>
              {!hasDaemon() ? (
                <p className="text-xs text-subtext-0">Connect to a host to manage email accounts.</p>
              ) : (
                <>
                  {emList.map((a) => (
                    <div key={a.id} className="g-inset px-3 py-2 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-text truncate flex-1" title={`${a.username} @ ${a.host}:${a.port}`}>
                          {a.label} <span className="text-xs text-subtext-0">{a.username} · {a.host}</span>
                        </span>
                        <button onClick={() => void emSync(a.id)} disabled={emBusy} className="g-btn g-btn-ghost g-btn-sm shrink-0">
                          Sync now
                        </button>
                        <button onClick={() => void emToggle(a)} className={`g-chip shrink-0 ${a.enabled ? 'g-on' : ''}`}>
                          {a.enabled ? 'On' : 'Off'}
                        </button>
                        <button onClick={() => void emDelete(a)} className="g-btn g-btn-danger g-btn-sm shrink-0">
                          ✕
                        </button>
                      </div>
                      <div className="text-xs text-subtext-0">
                        {a.folders ? `folders: ${a.folders}` : 'folders: INBOX'}
                        {` · ${a.horizon_days} day horizon`}
                        {a.last_result ? ` · last sync: ${a.last_result}` : ' · not synced yet'}
                      </div>
                    </div>
                  ))}

                  <div className="pt-1 space-y-2">
                    <div className="grid grid-cols-[1fr_1fr_6rem] gap-2">
                      <label className="block">
                        <span className="block text-xs text-subtext-0 mb-1">Account name <span className="opacity-60">(optional)</span></span>
                        <input value={emLabel} onChange={(e) => setEmLabel(e.target.value)} placeholder="Uni Gmail" className={`${input} w-full`} />
                      </label>
                      <label className="block">
                        <span className="block text-xs text-subtext-0 mb-1">IMAP server</span>
                        <input value={emHost} onChange={(e) => setEmHost(e.target.value)} placeholder="imap.gmail.com" className={`${input} w-full`} />
                      </label>
                      <label className="block">
                        <span className="block text-xs text-subtext-0 mb-1">Port</span>
                        <input value={emPort} onChange={(e) => setEmPort(e.target.value)} placeholder="993" inputMode="numeric" className={`${input} w-full`} />
                      </label>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-subtext-0">Sign-in method</span>
                      <button
                        onClick={() => setEmAuth('password')}
                        className={`g-chip ${emAuth === 'password' ? 'g-on' : ''}`}
                      >
                        App password
                      </button>
                      <button
                        onClick={() => setEmAuth('oauth')}
                        className={`g-chip ${emAuth === 'oauth' ? 'g-on' : ''}`}
                      >
                        Sign in with Google
                      </button>
                    </div>
                    {emAuth === 'password' ? (
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                          <span className="block text-xs text-subtext-0 mb-1">Email address</span>
                          <input value={emUser} onChange={(e) => setEmUser(e.target.value)} placeholder="you@gmail.com" className={`${input} w-full`} />
                        </label>
                        <label className="block">
                          <span className="block text-xs text-subtext-0 mb-1">App password</span>
                          <input value={emPass} onChange={(e) => setEmPass(e.target.value)} placeholder="16-character app password" type="password" className={`${input} w-full`} />
                        </label>
                      </div>
                    ) : (
                      <div className="space-y-2 rounded-lg border border-surface-2 p-3 bg-surface-0/40">
                        <p className="text-[11px] text-subtext-0">
                          One-time Google setup: console.cloud.google.com → APIs &amp; Services → Credentials → Create OAuth client
                          (type <span className="text-text">Desktop app</span>), then publish the consent screen. Paste its client
                          id below and sign in — Ganban never sees your password and stores only a refresh token.
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="block">
                            <span className="block text-xs text-subtext-0 mb-1">OAuth client id</span>
                            <input value={emClientId} onChange={(e) => setEmClientId(e.target.value)} placeholder="…apps.googleusercontent.com" className={`${input} w-full`} />
                          </label>
                          <label className="block">
                            <span className="block text-xs text-subtext-0 mb-1">Client secret <span className="opacity-60">(if shown)</span></span>
                            <input value={emClientSecret} onChange={(e) => setEmClientSecret(e.target.value)} placeholder="GOCSPX-…" type="password" className={`${input} w-full`} />
                          </label>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => void emSignIn()}
                            disabled={!emClientId.trim() || emBusy}
                            className="g-btn g-btn-ghost"
                          >
                            {emFlowId ? 'Re-sign in' : 'Sign in with Google'}
                          </button>
                          {emSignedInAs && <span className="text-xs text-success">✓ {emSignedInAs}</span>}
                        </div>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="block text-xs text-subtext-0 mb-1">Folders to watch <span className="opacity-60">(comma-separated)</span></span>
                        <input value={emFolders} onChange={(e) => setEmFolders(e.target.value)} placeholder="INBOX" className={`${input} w-full`} />
                      </label>
                      <label className="block">
                        <span className="block text-xs text-subtext-0 mb-1">History horizon <span className="opacity-60">(days)</span></span>
                        <input value={emHorizon} onChange={(e) => setEmHorizon(e.target.value)} placeholder="90" inputMode="numeric" className={`${input} w-full`} />
                      </label>
                    </div>
                    <p className="text-[11px] text-subtext-0">
                      Gmail: Google Account → Security → 2-Step Verification → App passwords → create one for Ganban.
                      Only message headers sync; full text is fetched only for threads you link to a project.
                    </p>
                    <div className="flex gap-2 items-center">
                      {emAuth === 'password' && (
                        <button onClick={() => void emTest()} disabled={!emHost.trim() || !emUser.trim() || !emPass || emBusy} className="g-btn g-btn-ghost">
                          Test
                        </button>
                      )}
                      <button onClick={() => void emAdd()} disabled={!emReady || emBusy} className="g-btn g-btn-pri">
                        {emBusy ? 'Working…' : 'Add account'}
                      </button>
                    </div>
                    {emMsg && <p className="text-xs text-subtext-1">{emMsg}</p>}
                  </div>
                </>
              )}
            </div>
          </div>
        );

      case 'connections':
        return (
          <div className="space-y-4">
            <H>AI Engines</H>
            {/* One-click: let Ganban launch + supervise the engines on THIS machine. */}
            {isTauri() && (
              <div className="bg-surface-1 border border-primary/40 rounded-lg p-4 space-y-3">
                <div className="font-medium text-text">Run the AI engines on this machine</div>
                <p className="text-sm text-subtext-0">
                  Ganban can start and supervise Ollama + ragrat for you (picks a free port, no console needed). Use this if this machine is your host.
                  After a successful Start they also come back automatically every time the app launches — Stop turns that off.
                </p>
                {engine && (
                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                    {(['ollama', 'ragrat'] as const).map((k) => (
                      <span key={k} className="flex items-center gap-1.5">
                        <span className={`inline-block w-2 h-2 rounded-full ${engine[k].running ? 'bg-success' : engine[k].found ? 'bg-warning' : 'bg-error'}`} />
                        <span className="capitalize">{k}</span>
                        <span className="text-subtext-0">
                          {engine[k].running ? 'running' : engine[k].found ? 'found, stopped' : 'not found'}
                          {engine[k].running && engine[k].workers != null && ` · ${engine[k].workers} ingest worker${engine[k].workers === 1 ? '' : 's'}`}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
                {engine && !engine.ragrat.found && (
                  <div className="space-y-1">
                    <label className="block text-xs text-subtext-0">ragrat binary path (e.g. <span className="font-mono">{isWindowsHost() ? 'C:\\ragrat\\.venv\\Scripts\\ragrat.exe' : '~/ragrat/.venv/bin/ragrat'}</span>)</label>
                    <div className="flex gap-2">
                      <input value={ragratPath} onChange={(e) => setRagratPath(e.target.value)} placeholder={isWindowsHost() ? '...\\.venv\\Scripts\\ragrat.exe' : '/path/to/.venv/bin/ragrat'} className={input} />
                      <button onClick={saveRagratPath} className="g-btn g-btn-ghost shrink-0">Save path</button>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <label className="text-xs text-subtext-0 shrink-0">ragrat ingest workers</label>
                  <input
                    value={ragratWorkers}
                    onChange={(e) => setRagratWorkersState(e.target.value)}
                    inputMode="numeric"
                    placeholder="1"
                    className={`${input} w-20`}
                  />
                  <button onClick={saveRagratWorkers} className="g-btn g-btn-ghost shrink-0">Save</button>
                  <span className="text-[11px] text-subtext-0">
                    Parallel ingestion across projects (1–16). Click Start engines to apply — a Ganban-managed ragrat is restarted with the new count; an externally-run one must be restarted by hand{ragratWorkersMsg ? ` — ${ragratWorkersMsg}` : ''}.
                  </span>
                </div>
                <div className="flex gap-2 items-center flex-wrap">
                  <button onClick={startEngines} disabled={engineBusy} className="g-btn g-btn-pri">
                    {engineBusy ? 'Working…' : 'Start engines'}
                  </button>
                  <button onClick={stopEngines} disabled={engineBusy || !engine?.managed} className="g-btn g-btn-ghost">Stop</button>
                  {engine?.ragrat.running && !engine.ragrat.managed && (
                    <button onClick={reclaimRagrat} disabled={engineBusy} title="Stop the ragrat on this port that Ganban didn't start, so Start engines can launch a managed one" className="g-btn g-btn-danger">
                      Stop external ragrat
                    </button>
                  )}
                  <button onClick={refreshEngine} disabled={engineBusy} className="px-3 py-2 text-sm text-subtext-0 hover:text-text">Refresh</button>
                  {engineMsg && <span className="text-sm text-subtext-1">{engineMsg}</span>}
                </div>
              </div>
            )}

            <p className="text-xs text-subtext-0">
              The assistant runs on your <span className="text-text">host</span>. Configure these while connected to it (online mode, or on the host machine itself). Saving applies immediately. The fields below are filled automatically when you use “Start engines”.
            </p>

            {/* Ollama (local model engine) */}
            <div className="g-card p-5 space-y-2">
              <div className="font-medium text-text">Ollama (local model engine)</div>
              <p className="text-sm text-subtext-0">Runs the chat model + embeddings on the host. Install with <span className="font-mono">brew install ollama</span> and <span className="font-mono">ollama serve</span>.</p>
              <input value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)} placeholder="http://127.0.0.1:11434" className={input} />
              <div className="flex gap-2 items-center flex-wrap">
                <button onClick={saveOllama} className="g-btn g-btn-pri">Save</button>
                <button onClick={testOllama} disabled={testing === 'ollama' || !ollamaUrl.trim()} className="g-btn g-btn-ghost">
                  {testing === 'ollama' ? 'Testing…' : 'Test'}
                </button>
                {ollamaMsg && <span className="text-sm text-subtext-1">{ollamaMsg}</span>}
              </div>
            </div>

            {/* ragrat (RAG sidecar) */}
            <div className="g-card p-5 space-y-2">
              <div className="font-medium text-text">ragrat (knowledge base)</div>
              <p className="text-sm text-subtext-0">Indexes each project's tasks, notes and files so the assistant can ground its answers. Optional — chat still works without it.</p>
              <input value={ragratUrl} onChange={(e) => setRagratUrl(e.target.value)} placeholder="http://127.0.0.1:8780" className={input} />
              <input value={ragratToken} onChange={(e) => setRagratToken(e.target.value)} placeholder="Service token (optional)" type="password" className={input} />
              <div className="flex gap-2 items-center flex-wrap">
                <button onClick={saveRagrat} className="g-btn g-btn-pri">Save</button>
                <button onClick={testRagrat} disabled={testing === 'ragrat' || !ragratUrl.trim()} className="g-btn g-btn-ghost">
                  {testing === 'ragrat' ? 'Testing…' : 'Test'}
                </button>
                {ragratMsg && <span className="text-sm text-subtext-1">{ragratMsg}</span>}
              </div>
            </div>

          </div>
        );

      case 'loadouts':
        return (
          <div className="space-y-4">
            <H>Loadouts</H>
            <LoadoutsPanel />
          </div>
        );

      case 'docs':
        return (
          <div className="space-y-4">
            <H>Documentation</H>
            <DocumentationPanel />
          </div>
        );

      case 'tools':
        return (
          <div className="space-y-4">
            <H>Tools</H>
            <p className="text-xs text-subtext-0">
              Every agent tool this build offers. Reads run immediately (project-scoped); writes only ever create
              proposals you approve. The knowledge-engine (ragrat / MCP) status is shown to the owner.
            </p>
            <ToolsPanel fill={false} />
          </div>
        );

      case 'models':
        return (
          <div className="space-y-4">
            <H>Models</H>
            <p className="text-xs text-subtext-0">Managed on the host's Ollama. Configure the Ollama connection first under <button className="text-primary" onClick={() => setSection('connections')}>AI Engines</button>.</p>

            {/* Chat model + params */}
            <div className="g-card p-5 space-y-3">
              <div className="font-medium text-text">Chat model</div>
              <div className="flex gap-2 items-center">
                <select value={chatModel} onChange={(e) => setChatModel(e.target.value)} className={input}>
                  <option value="">{models.length ? 'Select a model…' : 'No models — pull one below'}</option>
                  {models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                  {chatModel && !models.includes(chatModel) && <option value={chatModel}>{chatModel} (saved)</option>}
                </select>
                <button onClick={loadModels} className="g-btn g-btn-ghost shrink-0">Refresh</button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-subtext-0 mb-1">Temperature</label>
                  <input value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="0.7" className={input} />
                </div>
                <div>
                  <label className="block text-xs text-subtext-0 mb-1">Max tokens (blank = model default)</label>
                  <input value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="—" className={input} />
                </div>
              </div>
              <div className="flex gap-2 items-center">
                <button onClick={saveChatModel} disabled={!chatModel.trim()} className="g-btn g-btn-pri">Save</button>
                {modelMsg && <span className="text-sm text-subtext-1">{modelMsg}</span>}
              </div>
            </div>

            {/* Pull a model */}
            <div className="g-card p-5 space-y-2">
              <div className="font-medium text-text">Pull a model</div>
              <p className="text-sm text-subtext-0">Download a model onto the host (e.g. <span className="font-mono">llama3.1:8b</span>, <span className="font-mono">qwen2.5</span>).</p>
              <div className="flex gap-2 items-center">
                <input value={pullName} onChange={(e) => setPullName(e.target.value)} placeholder="model:tag" className={input} disabled={pulling} />
                <button onClick={doPull} disabled={pulling || !pullName.trim()} className="g-btn g-btn-pri shrink-0">
                  {pulling ? 'Pulling…' : 'Pull'}
                </button>
              </div>
              {pulling && pullPct != null && (
                <div className="w-full h-2 bg-surface-2 rounded overflow-hidden">
                  <div className="h-full bg-primary transition-all" style={{ width: `${pullPct}%` }} />
                </div>
              )}
            </div>

            {/* Embedding model (drives ragrat) */}
            <div className="g-card p-5 space-y-2">
              <div className="font-medium text-text">Embedding model</div>
              <p className="text-sm text-subtext-0">Used by the knowledge base. Changing it re-indexes every project (each index's dimensions are fixed). Pull it first if needed.</p>
              <div className="flex gap-2 items-center">
                <input value={embedModel} onChange={(e) => { setEmbedModel(e.target.value); setEmbedInfo(null); }} placeholder="nomic-embed-text" className={input} />
                <button onClick={doEmbedCheck} disabled={!embedModel.trim()} className="g-btn g-btn-ghost shrink-0">Check</button>
              </div>
              <div className="flex gap-2 items-center flex-wrap">
                <button onClick={saveEmbedAndReindex} disabled={!embedInfo || reembedding} className="g-btn g-btn-pri">
                  {reembedding ? 'Re-indexing…' : 'Save & re-index'}
                </button>
                {embedMsg && <span className="text-sm text-subtext-1">{embedMsg}</span>}
              </div>
            </div>

            {/* Vision model: in-document figure description at ingest time */}
            <div className="g-card p-5 space-y-2">
              <div className="font-medium text-text">Figure descriptions (vision model)</div>
              <p className="text-sm text-subtext-0">
                Charts, maps, diagrams and formula images inside PDFs get described by a vision model at ingest time and
                become searchable text (otherwise they index as <span className="font-mono">&lt;!-- image --&gt;</span> dead zones).
                One model call per figure per (re-)ingest — point it at a strong box if your documents are chart-heavy.
                Stored on the <span className="text-text">host</span> — set it once from any owner device; a desktop in
                local mode shows its own machine's setting, not the host's.
              </p>
              <div className="flex gap-2 items-center">
                <input
                  value={visionEndpoint}
                  onChange={(e) => setVisionEndpoint(e.target.value)}
                  placeholder="Engine URL (blank = this host's Ollama)"
                  className={input}
                />
                <button
                  onClick={() => {
                    setVisionMsg('Checking…');
                    listOllamaModels(visionEndpoint.trim() || undefined)
                      .then((ms) => {
                        setVisionModels(ms);
                        setVisionMsg(ms.length ? `Reachable ✓ — pick a model below.` : 'Reachable, but no models installed there.');
                      })
                      .catch((e) => {
                        setVisionModels([]);
                        setVisionMsg(e instanceof Error ? e.message : String(e));
                      });
                  }}
                  className="g-btn g-btn-ghost shrink-0"
                >
                  Check
                </button>
              </div>
              <div className="flex gap-2 items-center">
                <select value={visionModel} onChange={(e) => setVisionModel(e.target.value)} className={input}>
                  <option value="">{visionModels.length ? 'Off — no figure descriptions' : 'Hit Check to list the models there'}</option>
                  {visionModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                  {visionModel && !visionModels.includes(visionModel) && <option value={visionModel}>{visionModel} (saved)</option>}
                </select>
                <button
                  onClick={() => {
                    const endpoint = visionEndpoint.trim() || ollamaUrl || 'http://127.0.0.1:11434';
                    setAppSetting('rag_vision', visionModel.trim() ? JSON.stringify({ endpoint, model: visionModel.trim() }) : '')
                      .then(() => setVisionMsg(visionModel.trim()
                        ? 'Saved — applies to every (re-)ingest from now on; Re-ingest a collection to upgrade its existing documents.'
                        : 'Disabled.'))
                      .catch((e) => setVisionMsg(e instanceof Error ? e.message : String(e)));
                  }}
                  className="g-btn g-btn-pri shrink-0"
                >
                  Save
                </button>
              </div>
              {visionMsg && <span className="text-sm text-subtext-1">{visionMsg}</span>}
            </div>
          </div>
        );

      case 'personalities':
        return (
          <div className="space-y-4">
            <H>Personalities</H>
            <p className="text-xs text-subtext-0">
              A personality is a model + system prompt + parameters. The <span className="text-text">active</span> one answers in the Assistant; mark one as the <span className="text-text">secretary</span> to power the Home daily assistant; add more for different strengths.
            </p>

            <div className="space-y-2">
              {profiles.length === 0 && <p className="text-sm text-subtext-0 italic">No personalities yet. The Assistant uses the model set under <button className="text-primary" onClick={() => setSection('models')}>Models</button> until you create one.</p>}
              {profiles.map((p) => (
                <div key={p.id} className="g-card p-4 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <ProfileAvatar avatar={p.avatar} name={p.name} size={40} />
                    <div className="min-w-0">
                      <div className="font-medium text-text truncate">
                        {p.name} {activeProfileId === p.id && <span className="text-xs text-success">● active</span>}
                        {secretaryProfileId === p.id && <span className="ml-1 text-xs text-primary">🗓️ secretary</span>}
                      </div>
                      <div className="text-xs text-subtext-0 truncate font-mono">{p.model}</div>
                      <div className="mt-1"><ModelCard meta={parseModelMeta(p.model_meta)} /></div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {activeProfileId !== p.id && (
                      <button onClick={() => activateProfile(p.id)} className="g-btn g-btn-ghost g-btn-sm">Activate</button>
                    )}
                    <button
                      onClick={() => designateSecretary(secretaryProfileId === p.id ? null : p.id)}
                      className={`g-chip ${secretaryProfileId === p.id ? 'g-on' : ''}`}
                      title="The secretary answers the Home daily-assistant box and grounds your rundown"
                    >
                      {secretaryProfileId === p.id ? '✓ Secretary' : 'Secretary'}
                    </button>
                    <button
                      onClick={() => designateRouting('tools', toolProfileId === p.id ? null : p.id)}
                      className={`g-chip ${toolProfileId === p.id ? 'g-on' : ''}`}
                      title="When Tools mode is on, the tool loop runs on this model (pick your strongest tool-capable one)"
                    >
                      {toolProfileId === p.id ? '✓ Tool runner' : 'Tool runner'}
                    </button>
                    <button
                      onClick={() => designateRouting('librarian', librarianProfileId === p.id ? null : p.id)}
                      className={`g-chip ${librarianProfileId === p.id ? 'g-on' : ''}`}
                      title="ask_atlas research runs on this model — ideally a strong profile with a remote endpoint (the big box)"
                    >
                      {librarianProfileId === p.id ? '✓ Librarian' : 'Librarian'}
                    </button>
                    <button onClick={() => editProfile(p)} className="g-btn g-btn-ghost g-btn-sm">Edit</button>
                    <button onClick={() => removeProfile(p.id)} className="g-btn g-btn-danger g-btn-sm">Delete</button>
                  </div>
                </div>
              ))}
            </div>

            {/* Editor */}
            <div className="g-card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="font-medium text-text">{pEditId ? 'Edit personality' : 'New personality'}</div>
                {pEditId && <button onClick={newProfile} className="text-xs text-primary">+ New</button>}
              </div>
              {/* vCard: profile picture + identity */}
              <div className="flex items-center gap-3">
                <ProfileAvatar avatar={pAvatar} name={pName || 'A'} size={56} />
                <div className="flex gap-2">
                  <label className="px-2.5 py-1.5 text-xs bg-surface-2 text-text rounded-lg cursor-pointer hover:bg-overlay-0">
                    {pAvatar ? 'Change picture' : 'Add picture'}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        onAvatarPick(e.target.files?.[0] ?? null);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {pAvatar && (
                    <button onClick={() => setPAvatar(null)} className="g-btn g-btn-danger g-btn-sm">Remove</button>
                  )}
                </div>
              </div>
              <input value={pName} onChange={(e) => setPName(e.target.value)} placeholder="Name (e.g. Project assistant)" className={input} />
              <select value={pModel} onChange={(e) => setPModel(e.target.value)} className={input}>
                <option value="">{pEndpoint.trim() && pRemoteModels ? 'Select a remote model…' : 'Select a model…'}</option>
                {(pEndpoint.trim() && pRemoteModels ? pRemoteModels : models).map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
                {pModel && !(pEndpoint.trim() && pRemoteModels ? pRemoteModels : models).includes(pModel) && (
                  <option value={pModel}>{pModel} (saved)</option>
                )}
              </select>
              {pMeta && (
                <div className="space-y-1">
                  <div className="text-[11px] text-subtext-0">Model card</div>
                  <ModelCard meta={pMeta} />
                </div>
              )}
              <textarea value={pPrompt} onChange={(e) => setPPrompt(e.target.value)} rows={4} placeholder="System prompt / personality (how it should behave)…" className={input} />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-subtext-0 mb-1">Temperature</label>
                  <input value={pTemp} onChange={(e) => setPTemp(e.target.value)} placeholder="0.7" className={input} />
                </div>
                <div>
                  <label className="block text-xs text-subtext-0 mb-1">Max tokens (blank = default)</label>
                  <input value={pMax} onChange={(e) => setPMax(e.target.value)} placeholder="—" className={input} />
                </div>
              </div>
              <div>
                <label className="block text-xs text-subtext-0 mb-1">
                  Remote engine (optional) — an Ollama URL on another machine, e.g. <span className="font-mono">http://100.x.y.z:11434</span>. Reached over the tailnet, never supervised; blank = this host's engine.
                </label>
                <div className="flex gap-2">
                  <input value={pEndpoint} onChange={(e) => { setPEndpoint(e.target.value); setPRemoteModels(null); }} placeholder="http://… (blank = local)" className={input} />
                  <button
                    onClick={() => {
                      setProfileMsg('Testing…');
                      listOllamaModels(pEndpoint)
                        .then((ms) => { setPRemoteModels(ms); setProfileMsg(`Reachable ✓ — ${ms.length} model${ms.length === 1 ? '' : 's'}; pick one above.`); })
                        .catch((e) => { setPRemoteModels(null); setProfileMsg(e instanceof Error ? e.message : String(e)); });
                    }}
                    disabled={!pEndpoint.trim()}
                    className="g-btn g-btn-ghost shrink-0"
                  >
                    Test
                  </button>
                </div>
              </div>
              {pEndpoint.trim() && (
                <input
                  value={pFallback}
                  onChange={(e) => setPFallback(e.target.value)}
                  placeholder="What to say when it's unreachable (e.g. “the librarian's box is asleep — answering from the project corpus only”)"
                  className={input}
                />
              )}
              <div className="flex gap-2 items-center">
                <button onClick={saveProfile} disabled={!pName.trim() || !pModel.trim()} className="g-btn g-btn-pri">Save</button>
                {pEditId && activeProfileId !== pEditId && (
                  <button onClick={() => activateProfile(pEditId)} className="g-btn g-btn-ghost">Set active</button>
                )}
                {profileMsg && <span className="text-sm text-subtext-1">{profileMsg}</span>}
              </div>
            </div>

            {/* Task routing — the protocol layer. Each task class picks a runner
                (free Ollama or paid pi) + model. The first class: structure_toc
                (PDF Studio's auto-build ToC). */}
            <div className="g-card p-5 space-y-3">
              <div className="font-medium text-text">Task routing (protocols)</div>
              <p className="text-sm text-subtext-0">
                Agent tasks run on the runner you pick here. Ollama is free (local); pi uses external models
                (Anthropic/OpenAI/…) via the host's <span className="font-mono">pi</span> install — paid, under your control.
              </p>

              {/* structure_toc */}
              <div className="g-plain p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text">Auto-build PDF structure</span>
                  <span className="text-xs text-subtext-0">(structure_toc)</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="g-seg">
                    <button onClick={() => setTocRunner('ollama')}
                      className={`g-chip ${tocRunner === 'ollama' ? 'g-on' : ''}`}>Ollama (free)</button>
                    <button onClick={() => setTocRunner('pi')}
                      className={`g-chip ${tocRunner === 'pi' ? 'g-on' : ''}`}>pi (paid)</button>
                  </div>
                  {tocRunner === 'ollama' ? (
                    <select value={tocProfileId ?? ''} onChange={(e) => setTocProfileId(e.target.value ? Number(e.target.value) : null)}
                      className="flex-1 px-2 py-1 text-sm bg-surface-1 border border-surface-2 rounded-lg text-text">
                      <option value="">Active profile (default)</option>
                      {profiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.model})</option>)}
                    </select>
                  ) : (
                    <input value={tocPiModel} onChange={(e) => setTocPiModel(e.target.value)} placeholder="model pattern, e.g. anthropic/claude-sonnet-4 (blank = pi default)"
                      className="flex-1 px-2 py-1 text-sm bg-surface-1 border border-surface-2 rounded-lg text-text" />
                  )}
                  <button onClick={async () => {
                    try {
                      await setTaskProtocol({
                        task_class: 'structure_toc',
                        runner: tocRunner,
                        profile_id: tocRunner === 'ollama' ? tocProfileId : null,
                        model: tocRunner === 'pi' ? (tocPiModel.trim() || null) : null,
                      });
                      setTocMsg('Saved ✓');
                      setProtoNonce((n) => n + 1);
                    } catch (e) { setTocMsg(e instanceof Error ? e.message : String(e)); }
                  }} className="g-btn g-btn-pri g-btn-sm shrink-0">Save</button>
                </div>
                {tocMsg && <span className="text-xs text-subtext-1">{tocMsg}</span>}
              </div>

              {/* Protocols (Epoch R): list + lifecycle + builder + gallery — its own
                  component; remounts (key) after a routing save above so the new
                  immutable version shows immediately. */}
              <ProtocolsPanel key={protoNonce} profiles={profiles} />

              {/* pi binary path */}
              <div className="g-plain p-3 space-y-2">
                <div className="text-sm font-medium text-text">pi binary path (host)</div>
                <p className="text-xs text-subtext-0">Where to find <span className="font-mono">pi</span> on the host. Blank = search PATH. pi owns its own API keys in <span className="font-mono">~/.pi/agent/auth.json</span> — Ganban never stores them.</p>
                <div className="flex gap-2">
                  <input value={piBinaryPath} onChange={(e) => setPiBinaryPath(e.target.value)} placeholder="/opt/homebrew/bin/pi (blank = PATH)" className={input} />
                  <button onClick={async () => {
                    try { await setAppSetting('pi_binary_path', piBinaryPath.trim()); setTocMsg('pi path saved ✓'); }
                    catch (e) { setTocMsg(e instanceof Error ? e.message : String(e)); }
                  }} className="g-btn g-btn-ghost shrink-0">Save</button>
                </div>
              </div>
            </div>
          </div>
        );

      case 'sync':
        // The full Sync surface lives here now (moved out of the main nav).
        // Full-bleed (cancel the panel's p-5); SyncView flows naturally and the
        // panel's own overflow-y-auto scrolls it (no nested scroll = no clipped
        // bottom). The connectivity cards (this app's host URL + Tailscale
        // auto-share) live here too — they're about sharing/devices, not AI.
        return (
          <div className="-m-5">
            <SyncView />
            <div className="p-5 border-t border-surface-2 space-y-4">
              <div className="g-card p-5 space-y-1">
                <div className="text-sm text-subtext-0">Daemon URL (this app's connection to a host)</div>
                <div className="font-mono text-sm text-text break-all">{getDaemonBaseUrl() ?? 'Not set'}</div>
              </div>

              {/* Tailscale sharing (optional): one invite folds the network join in */}
              <div className="g-card p-5 space-y-2">
                <div className="font-medium text-text">Tailscale sharing (optional)</div>
                <p className="text-sm text-subtext-0">
                  Make one invite do both jobs: when you invite someone, Ganban also issues a one-time Tailscale
                  share of <span className="text-text">this machine</span>, so they accept the network and join the
                  project in a single step. Your credential stays on the host — it never reaches a member.
                </p>
                <details className="g-inset px-3 py-2">
                  <summary className="text-sm text-primary cursor-pointer select-none">How to set this up</summary>
                  <div className="text-xs text-subtext-0 space-y-1.5 pt-2">
                    <p>Use a <span className="text-text">personal API access token</span> — Tailscale scopes a device share to a <span className="text-text">user</span>, so the token must be tied to your account. Generate one at <span className="font-mono">login.tailscale.com → Settings → Keys → Generate access token</span> (starts with <span className="font-mono">tskey-api-…</span>), paste it below, leave Tailnet blank for your default, then <span className="text-text">Check</span> and pick this machine.</p>
                    <p><span className="text-warning">Tokens expire — 90 days at most</span> (pick 90 when generating). Check shows the date below, and invite panels warn in the last {TOKEN_RENEW_WARN_DAYS} days. When one expires, invites still issue but can't carry a machine-share until you paste a fresh token here — or attach a share link made by hand in the admin console (the invite panel offers that).</p>
                    <p><span className="text-warning">An OAuth client will NOT work for sharing</span>: it can list devices (so Check succeeds) but <span className="text-text">cannot mint a device share</span> (Tailscale returns a 400 — a share isn't scoped to a user). The OAuth fields are kept only as a fallback for the device list.</p>
                    <p>The credential stays on the host and never reaches a member.</p>
                  </div>
                </details>
                <input value={tsToken} onChange={(e) => setTsToken(e.target.value)} placeholder="API access token (tskey-api-… — required to issue shares)" type="password" className={input} />
                <input value={tsClientId} onChange={(e) => setTsClientId(e.target.value)} placeholder="OAuth client ID (lists devices only — can't share)" className={input} />
                <input value={tsClientSecret} onChange={(e) => setTsClientSecret(e.target.value)} placeholder="OAuth client secret" type="password" className={input} />
                <input value={tsTailnet} onChange={(e) => setTsTailnet(e.target.value)} placeholder="Tailnet (blank = your default)" className={input} />
                <div className="flex gap-2 items-center flex-wrap">
                  <button onClick={handleSaveTailscale} className="g-btn g-btn-pri">Save</button>
                  <button onClick={checkTailscale} disabled={tsChecking} className="g-btn g-btn-ghost">
                    {tsChecking ? 'Checking…' : 'Check'}
                  </button>
                  {tsMsg && <span className="text-sm text-subtext-1">{tsMsg}</span>}
                {tsExpiry && (
                  <span
                    className={`text-sm ${tsExpiry.days_left < 0 ? 'text-error' : tsExpiry.days_left <= TOKEN_RENEW_WARN_DAYS ? 'text-warning' : 'text-subtext-0'}`}
                    title={tsExpiry.expires}
                  >
                    {tsExpiry.days_left < 0
                      ? `Token expired ${-tsExpiry.days_left} day${-tsExpiry.days_left === 1 ? '' : 's'} ago — paste a new one.`
                      : `Token expires ${new Date(tsExpiry.expires).toLocaleDateString()} (${tsExpiry.days_left} day${tsExpiry.days_left === 1 ? '' : 's'}).`}
                  </span>
                )}
                </div>
                {tsShareWarn && (
                  <p className="text-xs text-warning bg-warning/10 border border-warning/30 rounded-lg px-2 py-1.5">
                    ⚠ {tsShareWarn}
                  </p>
                )}
                {(tsDevices.length > 0 || tsDeviceId) && (
                  <div className="space-y-1 pt-1">
                    <label className="block text-xs text-subtext-0">Which device is this server?</label>
                    <select value={tsDeviceId} onChange={(e) => void pickTailscaleDevice(e.target.value)} className={input}>
                      <option value="">Select the server device…</option>
                      {tsDevices.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name || d.hostname || d.id}{d.os ? ` · ${d.os}` : ''}{d.addresses?.length ? ` · ${d.addresses[0]}` : ''}
                        </option>
                      ))}
                      {tsDeviceId && !tsDevices.some((d) => d.id === tsDeviceId) && <option value={tsDeviceId}>{tsDeviceId} (saved)</option>}
                    </select>
                  </div>
                )}
              </div>
            </div>
          </div>
        );

      case 'account':
        return (
          <div className="space-y-4">
            <H>Switch user</H>
            <div className="g-card p-5">
              <label className="block text-sm font-medium text-text mb-3">Current user</label>
              <UserSwitcher currentUserId={currentUserId} onUserChange={onUserChange} />
            </div>
            <p className="text-sm text-subtext-0">Edit your card, avatar, details and profile PIN under <button className="text-primary" onClick={() => setSection('profile')}>Profile</button>.</p>
          </div>
        );

      case 'profiles':
        return (
          <div className="space-y-4 flex-1 min-h-0 flex flex-col">
            <H>Profiles on this host</H>
            <div className="flex-1 min-h-0 overflow-y-auto -m-6 mt-0">
              <UsersView />
            </div>
          </div>
        );

      case 'automations':
        return <AutomationsPanel />;

      case 'updates':
        return (
          <div className="space-y-5">
            <H>Updates</H>
            <p className="text-sm text-subtext-0 -mt-2">
              {isGithubBuild(UPDATE_CHANNEL) && isDesktopApp()
                ? 'This app came from GitHub Releases and updates from there, signed by the project.'
                : 'Updates come from your host, which builds and signs the apps. Nothing phones home.'}
            </p>
            <UpdatesPanel />

            {/* The /download page's builds, for a new device's first install: an
                advanced option, closed by default. Only where there's a host. */}
            {hasDaemon() && <ServeInstallersCard />}
          </div>
        );

      case 'feedback':
        return (
          <div className="space-y-5">
            <H>Feedback</H>
            <div className="g-card p-5 space-y-3">
              <p className="text-sm text-subtext-0">Hit a bug or want a feature? File it here — it goes to the host's queue.</p>
              <div className="flex gap-2">
                {(['bug', 'feature'] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setTicketKind(k)}
                    className={`px-3 py-1.5 text-sm rounded-lg border ${ticketKind === k ? 'border-primary bg-surface-2 text-text' : 'border-surface-2 text-subtext-1'}`}
                  >
                    {k === 'bug' ? '🐞 Bug' : '✨ Feature'}
                  </button>
                ))}
              </div>
              <input
                value={ticketTitle}
                onChange={(e) => setTicketTitle(e.target.value)}
                placeholder={ticketKind === 'bug' ? 'What went wrong?' : 'What would you like?'}
                className={input}
              />
              <textarea
                value={ticketBody}
                onChange={(e) => setTicketBody(e.target.value)}
                placeholder="Details (steps to reproduce, what you expected, etc.) — optional"
                rows={4}
                className={`${input} resize-y`}
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void submitTicket()}
                  disabled={ticketBusy || !ticketTitle.trim()}
                  className="g-btn g-btn-pri"
                >
                  {ticketBusy ? 'Sending…' : 'Submit'}
                </button>
                {ticketMsg && <span className="text-sm text-subtext-1">{ticketMsg}</span>}
              </div>
            </div>

            <div className="space-y-2">
              <div className="g-flbl">
                {amOwner ? 'All tickets' : 'Your tickets'}
              </div>
              {tickets.length === 0 ? (
                <p className="text-sm text-subtext-0 italic">No tickets yet.</p>
              ) : (
                tickets.map((t) => (
                  <div key={t.id} className="flex items-start gap-3 g-inset px-3 py-2">
                    <span className="shrink-0 text-base" title={t.kind}>{t.kind === 'bug' ? '🐞' : '✨'}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-text truncate">{t.title}</div>
                      {t.body && <div className="text-xs text-subtext-0 whitespace-pre-wrap break-words mt-0.5">{t.body}</div>}
                      <div className="text-[11px] text-subtext-0 mt-1">
                        {amOwner && t.submitter_name ? `${t.submitter_name} · ` : ''}{new Date(t.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    {amOwner ? (
                      <button
                        onClick={() => void toggleTicket(t)}
                        className={`g-tag shrink-0 ${t.status === 'open' ? 'g-tag-warn' : 'g-tag-ok'}`}
                        title="Toggle open/closed"
                      >
                        {t.status}
                      </button>
                    ) : (
                      <span className={`g-tag shrink-0 ${t.status === 'open' ? 'g-tag-warn' : 'g-tag-ok'}`}>
                        {t.status}
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        );

      case 'notifications':
        return (
          <div className="space-y-5">
            <H>Notifications</H>
            <p className="text-xs text-subtext-0">
              These are per-device — how loudly this machine nags you. “Starting soon” (15 min) and
              “starts in an hour” reminders always fire; the settings below control the day-level ones.
            </p>

            <div className="g-card p-5 space-y-2">
              <div className="font-medium text-text">Day-before heads-up</div>
              <p className="text-xs text-subtext-0">
                A single “X is tomorrow at 15:00” reminder, at most once per event.
              </p>
              <div className="flex flex-col gap-1.5 pt-1">
                {([
                  ['off', 'Off', 'never remind me the day before (default)'],
                  ['evening', 'Evening before', 'one heads-up after 17:00'],
                  ['all', 'Any time the day before', 'as soon as the event is a day away'],
                ] as const).map(([val, label, hint]) => (
                  <label key={val} className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="radio"
                      name="tomorrow-policy"
                      checked={tomorrowPolicy === val}
                      onChange={() => { setTomorrowPolicyState(val); setTomorrowPolicy(val); }}
                      className="accent-[var(--color-primary)]"
                    />
                    <span className="text-sm text-text">{label}</span>
                    <span className="text-xs text-subtext-0">— {hint}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="g-card p-5 space-y-2">
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <div className="font-medium text-text">Day-of reminder</div>
                  <p className="text-xs text-subtext-0">One “X is today at 15:00” per event, on the morning of.</p>
                </div>
                <input
                  type="checkbox"
                  checked={dayOfReminders}
                  onChange={(e) => { setDayOfRemindersState(e.target.checked); setDayOfEnabled(e.target.checked); }}
                  className="accent-[var(--color-primary)] w-4 h-4"
                />
              </label>
            </div>

            <p className="text-xs text-subtext-0">
              Day-level reminders keep office hours (07:00–21:00) and events two or more days out never
              notify. Each reminder fires once — restarting the app won't replay them.
            </p>
          </div>
        );

      case 'data':
        return (
          <div className="space-y-5">
            <H>Data &amp; Storage</H>

            <div className="g-card p-5 space-y-3">
              <div className="font-medium text-text">Shared-file storage</div>
              <div>
                <label className="block text-xs text-subtext-0 mb-1">Default allocation for new projects (MB)</label>
                <div className="flex gap-2">
                  <input value={defaultQuotaMb} onChange={(e) => setDefaultQuotaMb(e.target.value)} inputMode="numeric" className={`${input} max-w-[10rem]`} />
                  <button onClick={saveDefaultQuota} className="g-btn g-btn-pri">Save</button>
                </div>
              </div>
              <div className="border-t border-surface-2 pt-3">
                <label className="block text-xs text-subtext-0 mb-1">Per-project allocation (admin override)</label>
                <select value={selProject} onChange={(e) => setSelProject(Number(e.target.value))} className={`${input} mb-2`}>
                  <option value={0}>Select a project…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                {selProject > 0 && (
                  <div className="flex gap-2">
                    <input value={projQuotaMb} onChange={(e) => setProjQuotaMb(e.target.value)} inputMode="numeric" className={`${input} max-w-[10rem]`} />
                    <button onClick={saveProjectQuota} className="g-btn g-btn-pri">Set limit</button>
                  </div>
                )}
              </div>
              {storageMsg && <div className="text-sm text-subtext-1">{storageMsg}</div>}
            </div>

            {isTauri() && storagePaths && (
              <div className="g-card p-5 space-y-3">
                <div className="font-medium text-text">Where your data lives</div>
                <p className="text-sm text-subtext-0">
                  Everything Ganban stores on <span className="text-text">this machine</span> — your database and shared files — lives here.
                  {isDesktopOnline() && ' You’re connected to a remote host; these folders are this device’s local copy. The host keeps its own data on the host machine (see Report a bug for its log path).'}
                </p>
                <div className="text-[11px] font-mono break-all text-subtext-1 g-inset p-2">
                  {storagePaths.data_dir}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => void openFolder(storagePaths.data_dir)}
                    className="g-btn g-btn-pri"
                  >
                    Open data folder
                  </button>
                  <button
                    onClick={() => void openFolder(storagePaths.log_dir)}
                    className="g-btn g-btn-ghost"
                  >
                    Open logs folder
                  </button>
                </div>
              </div>
            )}

            <div className="g-card p-5 space-y-3">
              <div className="font-medium text-text">Linking local files</div>
              <p className="text-sm text-subtext-0">
                When you reference a local (unshared) file in a task description, Ganban must upload it to the server so the link resolves for everyone — which makes it available to anyone with access to the task. This warning confirms that before it happens.
              </p>
              <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
                <input
                  type="checkbox"
                  checked={warnLocalLink}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setWarnLocalLink(on);
                    localStorage.setItem('ganban:warn-local-file-link', on ? '1' : '0');
                  }}
                />
                Warn before linking a local file
              </label>
            </div>

            <div className="g-card p-5 space-y-3">
              <div className="font-medium text-text">Backup &amp; restore</div>
              <p className="text-sm text-subtext-0">Export your database to a file, or import a previous export (replaces current data — a backup is made first).</p>
              <div className="flex gap-3">
                <button onClick={handleExportDatabase} disabled={isExporting} className="g-btn g-btn-ghost flex-1">
                  {isExporting ? 'Exporting…' : 'Export'}
                </button>
                <button onClick={handleImportDatabase} disabled={isImporting} className="g-btn g-btn-danger flex-1">
                  {isImporting ? 'Importing…' : 'Import'}
                </button>
              </div>
            </div>
          </div>
        );
      case 'diagnostics':
        return <DiagnosticsPanel />;
    }
  };

  return (
    // No close-on-backdrop: sections like Profile have unsaved edits; close via ✕/Esc.
    <Modal onClose={onClose} title="Settings" closeOnScrim={false} className="w-[min(1200px,80vw)] min-w-[min(900px,calc(100vw-32px))] h-[88vh] max-h-[900px]">
          <div className="flex-1 min-h-0 flex mt-2 border-t border-gilt-b">
            <ScrollArea className="w-56 shrink-0 border-r border-gilt-b bg-mantle">
            <nav aria-label="Settings sections" className="px-3 py-3">
              {SECTION_GROUPS.map((grp) => {
                // Profile management belongs to the machine that hosts the
                // profiles; online clients manage membership via Members.
                // And a browser guest owns no machine at all: engines, the
                // local database, storage roots, app updates and device
                // pairing are all somebody else's host to run.
                const hostOnly: Section[] = ['connections', 'data', 'updates', 'sync'];
                // "Switch user" is the LOCAL multi-profile picker. On a hosted
                // client who you are is the pairing — a picker there changed
                // labels and nothing else, while looking like an account switch.
                const items = grp.items.filter(
                  (s) =>
                    (s.key !== 'profiles' || (isTauri() && !isDesktopOnline())) &&
                    (s.key !== 'account' || !isHostedClient()) &&
                    (!hostOnly.includes(s.key) || hasHostControls()),
                );
                if (items.length === 0) return null;
                return (
                  <div key={grp.group} className="mb-2">
                    <div className="g-flbl px-3 pt-3 pb-1">{grp.group}</div>
                    {items.map((s) => (
                      <button
                        key={s.key}
                        onClick={() => setSection(s.key)}
                        aria-current={section === s.key ? 'page' : undefined}
                        className={`w-full flex items-center gap-2 text-left min-h-[32px] px-3 rounded text-sm mb-0.5 ${
                          section === s.key ? 'bg-gilt-b text-gold font-medium' : 'text-subtext-1 hover:bg-surface-0 hover:text-text'
                        }`}
                      >
                        <span className="flex-1 min-w-0 truncate">{s.label}</span>
                        {section === s.key && <span className="g-gem" aria-hidden="true" />}
                      </button>
                    ))}
                  </div>
                );
              })}
              {/* Which build is this? The first question when "the option isn't
                  there" — dist/ isn't in git, and browsers cache index.html. */}
              <div className="px-3 pt-3 pb-1 text-[10px] text-overlay-0 font-mono" title="Build hash · date">
                build {buildLabel()}
              </div>
            </nav>
            </ScrollArea>
            <ScrollArea className="flex-1 min-w-0" contentClassName="g-form px-8 py-7">
              <div className="max-w-[860px] mx-auto">{renderSection()}</div>
            </ScrollArea>
          </div>

      {/* After the content, so focus starts on the content, not on ✕. */}
      <button onClick={onClose} className="g-iconbtn absolute top-3 right-3" aria-label="Close">✕</button>
    </Modal>
  );
}
