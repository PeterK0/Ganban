import { useState, useEffect } from 'react';
import type { Contact } from '../types';


interface ContactEditorProps {
  contact: Contact | null;
  onSave: (contactData: {
    full_name: string;
    occupation?: string;
    phone_numbers: string[];
    emails: string[];
    birthday?: string;
    notes?: string;
  }) => void;
  onDelete?: () => void;
  onClose: () => void;
}

export default function ContactEditor({ contact, onSave, onDelete, onClose }: ContactEditorProps) {
  const [fullName, setFullName] = useState('');
  const [occupation, setOccupation] = useState('');
  const [phoneNumbers, setPhoneNumbers] = useState<string[]>(['']);
  const [emails, setEmails] = useState<string[]>(['']);
  const [birthday, setBirthday] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (contact) {
      setFullName(contact.full_name);
      setOccupation(contact.occupation || '');

      // Parse phone numbers
      try {
        const phones = contact.phone_numbers ? JSON.parse(contact.phone_numbers) : [''];
        setPhoneNumbers(phones.length > 0 ? phones : ['']);
      } catch {
        setPhoneNumbers(['']);
      }

      // Parse emails
      try {
        const emailList = contact.emails ? JSON.parse(contact.emails) : [''];
        setEmails(emailList.length > 0 ? emailList : ['']);
      } catch {
        setEmails(['']);
      }

      setBirthday(contact.birthday ? contact.birthday.split('T')[0] : '');
      setNotes(contact.notes || '');
    } else {
      // Reset form for new contact
      setFullName('');
      setOccupation('');
      setPhoneNumbers(['']);
      setEmails(['']);
      setBirthday('');
      setNotes('');
    }
  }, [contact]);

  const handleAddPhone = () => {
    setPhoneNumbers([...phoneNumbers, '']);
  };

  const handleRemovePhone = (index: number) => {
    setPhoneNumbers(phoneNumbers.filter((_, i) => i !== index));
  };

  const handlePhoneChange = (index: number, value: string) => {
    const newPhones = [...phoneNumbers];
    newPhones[index] = value;
    setPhoneNumbers(newPhones);
  };

  const handleAddEmail = () => {
    setEmails([...emails, '']);
  };

  const handleRemoveEmail = (index: number) => {
    setEmails(emails.filter((_, i) => i !== index));
  };

  const handleEmailChange = (index: number, value: string) => {
    const newEmails = [...emails];
    newEmails[index] = value;
    setEmails(newEmails);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!fullName.trim()) {
      alert('Full name is required');
      return;
    }

    // Filter out empty values
    const validPhones = phoneNumbers.filter(p => p.trim());
    const validEmails = emails.filter(e => e.trim());

    onSave({
      full_name: fullName.trim(),
      occupation: occupation.trim() || undefined,
      phone_numbers: validPhones,
      emails: validEmails,
      birthday: birthday || undefined,
      notes: notes.trim() || undefined,
    });
  };

  if (!contact && !onSave) return null;

  return (
    <div className="w-96 bg-base border-l border-gilt-a flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-[22px] py-3 border-b border-gilt-b flex items-center justify-between gap-2">
        <h2 className="g-deco text-[13px] font-semibold text-gold">
          {contact ? 'Edit Contact' : 'New Contact'}
        </h2>
        <button
          onClick={onClose}
          className="g-iconbtn"
          title="Close"
          aria-label="Close"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-[22px] pt-5 pb-7 space-y-[18px]">
        {/* Full Name */}
        <div>
          <label className="g-flbl">
            Full Name *
          </label>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className={`g-field font-semibold`}
            placeholder="John Doe"
            required
          />
        </div>

        {/* Occupation */}
        <div>
          <label className="g-flbl">
            Occupation
          </label>
          <input
            type="text"
            value={occupation}
            onChange={(e) => setOccupation(e.target.value)}
            className="g-field"
            placeholder="Software Engineer"
          />
        </div>

        {/* Phone Numbers */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className={`g-flbl !mb-0`}>
              Phone Numbers
            </label>
            <button
              type="button"
              onClick={handleAddPhone}
              className="g-lnk !min-h-[32px]"
            >
              + Add
            </button>
          </div>
          {phoneNumbers.map((phone, index) => (
            <div key={index} className="flex gap-2 mb-2">
              <input
                type="tel"
                value={phone}
                onChange={(e) => handlePhoneChange(index, e.target.value)}
                className={`g-field flex-1`}
                placeholder="+1 (555) 123-4567"
              />
              {phoneNumbers.length > 1 && (
                <button
                  type="button"
                  onClick={() => handleRemovePhone(index)}
                  className="g-iconbtn !w-10 !h-10 !text-error hover:!bg-error/10" aria-label="Remove"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Emails */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className={`g-flbl !mb-0`}>
              Email Addresses
            </label>
            <button
              type="button"
              onClick={handleAddEmail}
              className="g-lnk !min-h-[32px]"
            >
              + Add
            </button>
          </div>
          {emails.map((email, index) => (
            <div key={index} className="flex gap-2 mb-2">
              <input
                type="email"
                value={email}
                onChange={(e) => handleEmailChange(index, e.target.value)}
                className={`g-field flex-1`}
                placeholder="john@example.com"
              />
              {emails.length > 1 && (
                <button
                  type="button"
                  onClick={() => handleRemoveEmail(index)}
                  className="g-iconbtn !w-10 !h-10 !text-error hover:!bg-error/10" aria-label="Remove"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Birthday */}
        <div>
          <label className="g-flbl">
            Birthday
          </label>
          <input
            type="date"
            value={birthday}
            onChange={(e) => setBirthday(e.target.value)}
            className="g-field"
          />
        </div>

        {/* Notes */}
        <div>
          <label className="g-flbl">
            Notes
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            className={`g-field py-2.5 leading-relaxed resize-y`}
            placeholder="Additional notes..."
          />
        </div>
      </form>

      {/* Actions */}
      <div className="px-[22px] py-3.5 border-t border-gilt-a bg-mantle flex gap-2">
        {contact && onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="g-btn g-btn-danger"
          >
            Delete
          </button>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="g-btn g-btn-ghost"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          className="g-btn g-btn-pri g-glint"
        >
          {contact ? 'Update' : 'Create'}
        </button>
      </div>
    </div>
  );
}
