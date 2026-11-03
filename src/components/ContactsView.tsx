import { useState, useEffect } from 'react';
import { getContacts, createContact, updateContact, deleteContact } from '../lib/api';
import { hasDaemon } from '../lib/daemon';
import type { Contact, CreateContactInput } from '../types';
import ContactEditor from './ContactEditor';
import ContactProjectModal from './ContactProjectModal';
import { PendingInvitesPanel } from './PendingInvitesPanel';
import ScrollArea from './ScrollArea';
import { confirmDialog } from '../lib/confirm';

const MUTED = 'text-[color:var(--g-mut)]';
const FG2 = 'text-[color:var(--g-fg2)]';

export default function ContactsView() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [projectModalContact, setProjectModalContact] = useState<Contact | null>(null);

  useEffect(() => {
    loadContacts();
  }, []);

  const loadContacts = async () => {
    setIsLoading(true);
    try {
      const contactsList = await getContacts(false); // Only load non-archived contacts
      setContacts(contactsList);
    } catch (error) {
      console.error('Failed to load contacts:', error);
      alert('Failed to load contacts');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateContact = () => {
    setSelectedContact(null);
    setIsEditorOpen(true);
  };

  const handleEditContact = (contact: Contact) => {
    setSelectedContact(contact);
    setIsEditorOpen(true);
  };

  const handleSaveContact = async (contactData: {
    full_name: string;
    occupation?: string;
    phone_numbers: string[];
    emails: string[];
    birthday?: string;
    notes?: string;
  }) => {
    try {
      const input: CreateContactInput = {
        full_name: contactData.full_name,
        occupation: contactData.occupation,
        phone_numbers: JSON.stringify(contactData.phone_numbers),
        emails: JSON.stringify(contactData.emails),
        birthday: contactData.birthday,
        notes: contactData.notes,
      };

      if (selectedContact) {
        await updateContact(selectedContact.id, input);
      } else {
        await createContact(input);
      }

      await loadContacts();
      setIsEditorOpen(false);
      setSelectedContact(null);
    } catch (error) {
      console.error('Failed to save contact:', error);
      alert('Failed to save contact');
    }
  };

  const handleDeleteContact = async () => {
    if (!selectedContact) return;

    if (await confirmDialog(`Are you sure you want to delete ${selectedContact.full_name}?`)) {
      try {
        await deleteContact(selectedContact.id);
        await loadContacts();
        setIsEditorOpen(false);
        setSelectedContact(null);
      } catch (error) {
        console.error('Failed to delete contact:', error);
        alert('Failed to delete contact');
      }
    }
  };

  const parsePhones = (phonesJson?: string): string[] => {
    try {
      return phonesJson ? JSON.parse(phonesJson) : [];
    } catch {
      return [];
    }
  };

  const parseEmails = (emailsJson?: string): string[] => {
    try {
      return emailsJson ? JSON.parse(emailsJson) : [];
    } catch {
      return [];
    }
  };

  const formatBirthday = (birthday?: string): string => {
    if (!birthday) return '';
    const date = new Date(birthday);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const filteredContacts = contacts.filter(contact => {
    const query = searchQuery.toLowerCase();
    const fullNameMatch = contact.full_name.toLowerCase().includes(query);
    const occupationMatch = contact.occupation?.toLowerCase().includes(query);
    const phones = parsePhones(contact.phone_numbers);
    const phoneMatch = phones.some(p => p.toLowerCase().includes(query));
    const emails = parseEmails(contact.emails);
    const emailMatch = emails.some(e => e.toLowerCase().includes(query));

    return fullNameMatch || occupationMatch || phoneMatch || emailMatch;
  });

  return (
    <div className="flex h-full">
      <div className="flex-1 min-w-0 flex flex-col bg-mantle">
        {/* Header */}
        <div className="px-8 pt-[30px] pb-5 border-b border-gilt-b">
          <div className="flex items-end justify-between gap-4 flex-wrap mb-5">
            <div className="min-w-0">
              <div className="g-deco text-xs text-gold">
                {contacts.length} contact{contacts.length === 1 ? '' : 's'}
              </div>
              <h1 className="g-ptitle text-text">Contacts</h1>
              <p className={`text-sm mt-2 ${MUTED}`}>
                Manage your contacts and link them to tasks
              </p>
            </div>
            <button onClick={handleCreateContact} className="g-btn g-btn-pri g-glint">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New Contact
            </button>
          </div>

          {/* Search */}
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search contacts..."
              aria-label="Search contacts"
              className={`g-field pl-10`}
            />
            <svg
              className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${MUTED}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>
        </div>

        {/* Content */}
        <ScrollArea className="flex-1 min-h-0" contentClassName="px-8 pt-6 pb-16">
          {/* Outstanding invites you've sent — review & revoke stale ones. Only
              shows where there's a host and you're allowed to list them. */}
          {hasDaemon() && <PendingInvitesPanel />}
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <p className={MUTED}>Loading contacts...</p>
            </div>
          ) : filteredContacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <svg className="w-16 h-16 text-gilt-a mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
              <p className="g-deco text-[15px] text-text mb-2">
                {searchQuery ? 'No contacts found' : 'No Contacts Yet'}
              </p>
              <p className={`mb-5 ${MUTED}`}>
                {searchQuery ? 'Try a different search' : 'Create your first contact to get started'}
              </p>
              {!searchQuery && (
                <button onClick={handleCreateContact} className="g-btn g-btn-gilt">
                  Create Contact
                </button>
              )}
            </div>
          ) : (
            <div className="grid gap-[18px] grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))]">
              {filteredContacts.map((contact) => {
                const phones = parsePhones(contact.phone_numbers);
                const emails = parseEmails(contact.emails);
                const open = isEditorOpen && selectedContact?.id === contact.id;

                return (
                  <div
                    key={contact.id}
                    onClick={() => handleEditContact(contact)}
                    className={`g-card g-glint p-5 flex flex-col min-w-0 cursor-pointer transition-colors ${
                      open ? '!border-gold' : 'hover:border-gold/55'
                    }`}
                  >
                    <div className="flex items-start gap-3.5">
                      <span className="g-av !w-12 !h-12 !text-[16px]">
                        {contact.full_name.charAt(0).toUpperCase()}
                      </span>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-text truncate">
                          {contact.full_name}
                        </h3>
                        {contact.occupation && (
                          <p className={`text-sm truncate ${MUTED}`}>
                            {contact.occupation}
                          </p>
                        )}

                        {phones.length > 0 && (
                          <div className="mt-2">
                            {phones.slice(0, 2).map((phone, i) => (
                              <p key={i} className={`text-xs truncate flex items-center gap-1.5 ${FG2}`}>
                                <svg className={`w-3 h-3 shrink-0 ${MUTED}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                                </svg>
                                {phone}
                              </p>
                            ))}
                            {phones.length > 2 && (
                              <p className={`text-xs ${MUTED}`}>+{phones.length - 2} more</p>
                            )}
                          </div>
                        )}

                        {emails.length > 0 && (
                          <div className="mt-1">
                            {emails.slice(0, 1).map((email, i) => (
                              <p key={i} className={`text-xs truncate flex items-center gap-1.5 ${FG2}`}>
                                <svg className={`w-3 h-3 shrink-0 ${MUTED}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                </svg>
                                {email}
                              </p>
                            ))}
                            {emails.length > 1 && (
                              <p className={`text-xs ${MUTED}`}>+{emails.length - 1} more</p>
                            )}
                          </div>
                        )}

                        {contact.birthday && (
                          <p className={`text-xs mt-1 flex items-center gap-1.5 ${FG2}`}>
                            <svg className={`w-3 h-3 shrink-0 ${MUTED}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                            {formatBirthday(contact.birthday)}
                          </p>
                        )}
                      </div>
                      {contact.user_id != null && (
                        <span
                          className="g-tag g-tag-ok shrink-0 !min-h-[20px] !px-2 !text-[11px]"
                          title="Has a linked account — reusable across projects"
                        >
                          account
                        </span>
                      )}
                    </div>
                    {hasDaemon() && (
                      <div className="mt-3 pt-2 border-t border-gilt-b flex justify-end" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => setProjectModalContact(contact)}
                          className="g-lnk"
                        >
                          {contact.user_id != null ? 'Add to project →' : 'Invite to project →'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Editor Panel */}
      {isEditorOpen && (
        <ContactEditor
          contact={selectedContact}
          onSave={handleSaveContact}
          onDelete={selectedContact ? handleDeleteContact : undefined}
          onClose={() => {
            setIsEditorOpen(false);
            setSelectedContact(null);
          }}
        />
      )}

      {/* Add-to-project / invite */}
      {projectModalContact && (
        <ContactProjectModal
          contact={projectModalContact}
          onClose={() => setProjectModalContact(null)}
          onChanged={loadContacts}
        />
      )}
    </div>
  );
}
