// Repair Desk inside Shopify POS.
//
// Who is working comes from the staff member pinned into POS; the server links
// that POS account to a Repair Desk name the first time. Every call carries the
// POS session token, which the server checks before doing anything.

import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState, useCallback } from 'preact/hooks';
import { BACKEND } from './config.js';

export default async () => {
  render(<RepairDesk />, document.body);
};

// ------------------------------------------------------------------ server

function pinnedStaffId() {
  const s = shopify.session;
  return s?.staffMember?.value?.id ?? s?.currentSession?.staffMemberId ?? s?.currentSession?.userId ?? '';
}

async function api(path, body) {
  const token = await shopify.session.getSessionToken();
  const res = await fetch(BACKEND + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Pos-Staff-Member': String(pinnedStaffId()),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409 && data.needsLink) throw Object.assign(new Error(data.error), { needsLink: true, staff: data.staff });
  if (!res.ok) throw new Error(data.error || `Repair Desk answered ${res.status}`);
  return data;
}

const money = (c) => (c === null || c === undefined ? '—' : `$${(c / 100).toFixed(2)}`);
const daysIn = (iso) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 864e5));
const requestId = () => `pos_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
const toast = (m) => shopify.toast?.show?.(m);
const JOB = /([A-Z]{2,8}-\d{4,6})/i;

// ------------------------------------------------------------------- shell

function RepairDesk() {
  const [view, setView] = useState({ name: 'home' });
  const [me, setMe] = useState(null);
  const [link, setLink] = useState(null); // staff list when this POS account isn't linked yet
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await api('/api/me');
      setMe(r);
      setLink(null);
    } catch (e) {
      if (e.needsLink) setLink(e.staff);
      else setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    // A different staff member pinning in changes who is working.
    const unsub = shopify.session?.staffMember?.subscribe?.(() => load());
    return () => unsub?.();
  }, [load]);

  // A scanned label opens its ticket from anywhere in the Repair Desk.
  useEffect(() => {
    const unsub = shopify.scanner?.scannerData?.current?.subscribe?.((scan) => {
      const m = JOB.exec(String(scan?.data || ''));
      if (m) {
        shopify.scanner.hideCameraScanner?.();
        setView({ name: 'ticket', job: m[1].toUpperCase() });
      }
    });
    return () => unsub?.();
  }, []);

  const go = (v) => setView(v);

  if (link) return <LinkStaff staff={link} onDone={load} />;
  if (!me) {
    return (
      <s-page heading="Repair Desk">
        <s-scroll-box>
          <s-stack direction="block" gap="base">
            {error ? <s-text tone="critical">{error}</s-text> : <s-text>Loading…</s-text>}
            {error && <s-button onClick={load}>Try again</s-button>}
          </s-stack>
        </s-scroll-box>
      </s-page>
    );
  }
  if (view.name === 'checkin') return <CheckIn go={go} />;
  if (view.name === 'settings' && me.me.owner) return <Settings go={go} />;
  if (view.name === 'find') return <Find go={go} />;
  if (view.name === 'ticket') return <Ticket job={view.job} go={go} me={me} />;
  const switchUser = async () => {
    try {
      await api('/api/pos/unlink', {});
      setMe(null);
      load();
    } catch (e) {
      setError(e.message);
    }
  };
  return <Home go={go} me={me} onSwitch={switchUser} />;
}

// --------------------------------------------------------- first-time link

function LinkStaff({ staff, onDone }) {
  const [error, setError] = useState('');
  async function pick(s) {
    try {
      await api('/api/pos/link', { staffId: s.id });
      toast(`Linked to ${s.name}`);
      onDone();
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <s-page heading="Who's working?">
      <s-scroll-box>
        <s-stack direction="block" gap="base">
          <s-text>Tap your name once. After that the Repair Desk knows you from your POS PIN. Picked the wrong one? Use "Not you? Switch" on the next screen.</s-text>
          {staff.map((s) => (
            <s-button key={s.id} onClick={() => pick(s)}>{s.name}</s-button>
          ))}
          {error && <s-text tone="critical">{error}</s-text>}
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}

// -------------------------------------------------------------------- home

const STAGES = [
  ['Dropped off', ['received', 'inspected', 'awaiting_approval']],
  ['With Keith', ['at_partner']],
  ['Back from Keith', ['back_from_partner']],
  ['Ready for pickup', ['ready_for_pickup']],
];

function Home({ go, me, onSwitch }) {
  const [tickets, setTickets] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api('/api/board').then((r) => setTickets(r.tickets)).catch((e) => setError(e.message));
  }, []);
  return (
    <s-page heading="Repair Desk">
      <s-scroll-box>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-text>Working: {me.me.name}{me.printing ? '' : ' · label printing off'}</s-text>
            <s-button variant="secondary" onClick={onSwitch}>Not you? Switch</s-button>
          </s-stack>
          <s-stack direction="inline" gap="base">
            <s-button variant="primary" onClick={() => go({ name: 'checkin' })}>Check in a board</s-button>
            <s-button onClick={() => go({ name: 'find' })}>Find a board</s-button>
            <s-button onClick={() => shopify.scanner.showCameraScanner()}>Scan label</s-button>
            {me.me.owner && <s-button onClick={() => go({ name: 'settings' })}>Settings</s-button>}
          </s-stack>
          {error && <s-text tone="critical">{error}</s-text>}
          {!tickets && !error && <s-text>Loading boards…</s-text>}
          {tickets &&
            STAGES.map(([name, statuses]) => {
              const list = tickets.filter((t) => statuses.includes(t.status));
              return (
                <s-section key={name} heading={`${name} · ${list.length}`}>
                  <s-stack direction="block" gap="small">
                    {list.length === 0 && <s-text>None</s-text>}
                    {list.map((t) => <JobButton key={t.jobNumber} t={t} go={go} />)}
                  </s-stack>
                </s-section>
              );
            })}
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}

function JobButton({ t, go }) {
  const d = daysIn(t.receivedAt);
  const owes = t.price === null ? 'no price yet' : t.balance > 0 ? `owes ${money(t.balance)}` : 'paid';
  return (
    <s-button onClick={() => go({ name: 'ticket', job: t.jobNumber })}>
      {`${t.jobNumber} · ${t.customer} · ${t.board || t.repair} · ${d === 0 ? 'today' : `${d}d`} · ${owes}`}
    </s-button>
  );
}

// ---------------------------------------------------------------- check in

function CheckIn({ go }) {
  const [rid] = useState(requestId);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [adding, setAdding] = useState(false);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [phone, setPhone] = useState('');
  const [board, setBoard] = useState('');
  const [repair, setRepair] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) return setResults([]);
    const t = setTimeout(() => {
      api(`/api/customers?q=${encodeURIComponent(q.trim())}`).then((r) => setResults(r.customers)).catch((e) => setError(e.message));
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  async function addCustomer() {
    setError('');
    try {
      const r = await api('/api/customers', { firstName: first.trim(), lastName: last.trim(), phone: phone.trim() });
      setCustomer(r.customer);
      setAdding(false);
    } catch (e) {
      setError(e.message);
    }
  }

  async function submit() {
    setError('');
    if (!customer) return setError('Pick or add the customer first.');
    setBusy(true);
    try {
      const r = await api('/api/tickets', { requestId: rid, customer, board, repair, notes });
      const lbl = r.label?.status === 'sent' ? 'Label printed.' : r.label?.status === 'off' ? 'Label printing is off.' : `Label didn't print: ${r.label?.error || 'use Reprint'}`;
      toast(`${r.jobNumber} checked in. ${lbl}`);
      go({ name: 'ticket', job: r.jobNumber });
    } catch (e) {
      setBusy(false);
      setError(e.message);
    }
  }

  return (
    <s-page heading="Check in a board">
      <s-scroll-box>
        <s-stack direction="block" gap="base">
          <s-section heading="Customer">
            <s-stack direction="block" gap="small">
              {customer ? (
                <s-stack direction="inline" gap="base">
                  <s-text>{customer.displayName}{customer.phoneE164 ? ` · ${customer.phoneE164}` : ''}</s-text>
                  <s-button onClick={() => setCustomer(null)}>Change</s-button>
                </s-stack>
              ) : adding ? (
                <s-stack direction="block" gap="small">
                  <s-text-field label="First name" value={first} onInput={(e) => setFirst(e.currentTarget.value)} />
                  <s-text-field label="Last name" value={last} onInput={(e) => setLast(e.currentTarget.value)} />
                  <s-text-field label="Phone" value={phone} onInput={(e) => setPhone(e.currentTarget.value)} />
                  <s-stack direction="inline" gap="base">
                    <s-button variant="primary" onClick={addCustomer}>Add customer</s-button>
                    <s-button onClick={() => setAdding(false)}>Back to search</s-button>
                  </s-stack>
                </s-stack>
              ) : (
                <s-stack direction="block" gap="small">
                  <s-text-field label="Search phone or name" value={q} placeholder="516 555 0101" onInput={(e) => setQ(e.currentTarget.value)} />
                  {results.map((c) => (
                    <s-button key={c.shopifyCustomerGid} onClick={() => setCustomer(c)}>
                      {`${c.displayName}${c.phoneE164 ? ` · ${c.phoneE164}` : ''}`}
                    </s-button>
                  ))}
                  <s-button onClick={() => {
                    const isPhone = /\d{3}/.test(q);
                    setFirst(isPhone ? '' : q.trim().split(' ')[0] || '');
                    setLast(isPhone ? '' : q.trim().split(' ').slice(1).join(' '));
                    setPhone(isPhone ? q.trim() : '');
                    setAdding(true);
                  }}>+ New customer</s-button>
                </s-stack>
              )}
            </s-stack>
          </s-section>
          <s-text-field label="Board" value={board} placeholder="9'0 Fish Stix, blue" onInput={(e) => setBoard(e.currentTarget.value)} />
          <s-text-field label="What's wrong" value={repair} placeholder="Rail ding near the nose" onInput={(e) => setRepair(e.currentTarget.value)} />
          <s-text-field label="Notes: fins, leash, bag" value={notes} onInput={(e) => setNotes(e.currentTarget.value)} />
          <s-text>Green tape on every ding. Name and phone on the bottom of the board.</s-text>
          {error && <s-text tone="critical">{error}</s-text>}
          <s-button variant="primary" disabled={busy} onClick={submit}>Check in and print label</s-button>
          <s-button onClick={() => go({ name: 'home' })}>Cancel</s-button>
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}

// -------------------------------------------------------------------- find

function Find({ go }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState({ open: [], archive: [] });
  const [error, setError] = useState('');
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setFound({ open: [], archive: [] });
    const t = setTimeout(() => api(`/api/find?q=${encodeURIComponent(term)}`).then(setFound).catch((e) => setError(e.message)), 300);
    return () => clearTimeout(t);
  }, [q]);
  const m = JOB.exec(q.trim());
  return (
    <s-page heading="Find a board">
      <s-scroll-box>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-button onClick={() => shopify.scanner.showCameraScanner()}>Scan label</s-button>
            <s-button onClick={() => go({ name: 'home' })}>Back</s-button>
          </s-stack>
          <s-text-field label="Job number, name or phone" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
          {m && <s-button variant="primary" onClick={() => go({ name: 'ticket', job: m[1].toUpperCase() })}>{`Open ${m[1].toUpperCase()}`}</s-button>}
          {error && <s-text tone="critical">{error}</s-text>}
          <s-section heading={`In the shop · ${found.open.length}`}>
            <s-stack direction="block" gap="small">
              {found.open.map((t) => <JobButton key={t.jobNumber} t={t} go={go} />)}
            </s-stack>
          </s-section>
          <s-section heading={`Old repairs · ${found.archive.length}`}>
            <s-stack direction="block" gap="small">
              {found.archive.map((a) => (
                <s-text key={a.jobNumber}>{`${a.jobNumber} · ${a.customer || 'No name'} · ${a.board || ''} · ${a.status}${a.price ? ` · ${a.price} ${a.payment}` : ''}`}</s-text>
              ))}
            </s-stack>
          </s-section>
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}

// ------------------------------------------------------------------ ticket

function Ticket({ job, go, me }) {
  const [t, setT] = useState(null);
  const [archived, setArchived] = useState(null);
  const [error, setError] = useState('');
  const [charge, setCharge] = useState('');
  const [fee, setFee] = useState('');
  const [agreed, setAgreed] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const show = (ticket) => {
    setT(ticket);
    setCharge(ticket.money.partnerCharge === null ? '' : (ticket.money.partnerCharge / 100).toFixed(2));
    setFee(((ticket.money.shopFee ?? 0) / 100).toFixed(2));
    setAgreed(ticket.money.agreedPrice === null ? '' : (ticket.money.agreedPrice / 100).toFixed(2));
  };
  useEffect(() => {
    api(`/api/tickets/${encodeURIComponent(job)}`)
      .then((r) => (r.archived ? setArchived(r.archived) : show(r.ticket)))
      .catch((e) => setError(e.message));
  }, [job]);

  async function act(path, body, done) {
    setError('');
    setBusy(true);
    try {
      const r = await api(`/api/tickets/${job}/${path}`, body);
      if (r.ticket) show(r.ticket);
      if (done) toast(done);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }

  async function addToCart() {
    const price = t.money.balance ?? t.money.price;
    if (!(price > 0)) return setError("Enter Keith's charge first.");
    try {
      const props = { 'Repair job': t.jobNumber };
      if (me.dingRepairVariantId) {
        // Live store: the Ding Repair product, as the shop rings it up today.
        await shopify.cart.addLineItem(Number(me.dingRepairVariantId), 1, { properties: props });
        toast(`Added ${t.jobNumber}. Set the price to ${money(price)} in the cart.`);
      } else {
        const uuid = await shopify.cart.addCustomSale({ title: `Ding repair ${t.jobNumber}`, quantity: 1, price: (price / 100).toFixed(2), taxable: true });
        if (uuid) await shopify.cart.addLineItemProperties(uuid, props);
        toast(`Added ${t.jobNumber} · ${money(price)} to the cart`);
      }
    } catch (e) {
      setError(`Couldn't add to the cart: ${e.message || e}`);
    }
  }

  if (archived) {
    return (
      <s-page heading={job}>
        <s-scroll-box>
          <s-stack direction="block" gap="base">
            <s-text>Old repair from the spreadsheet. It can be read but not changed.</s-text>
            <s-text>{`${archived.customer || 'No name'} · ${archived.phone || ''}`}</s-text>
            <s-text>{`${archived.board || ''} — ${archived.repair || ''}`}</s-text>
            <s-text>{`${archived.status} · in ${archived.received || '?'} · out ${archived.pickedUp || '?'} · ${archived.price || 'no price'} ${archived.payment || ''}`}</s-text>
            {archived.notes && <s-text>{archived.notes}</s-text>}
            <s-button onClick={() => go({ name: 'home' })}>Back</s-button>
          </s-stack>
        </s-scroll-box>
      </s-page>
    );
  }
  if (!t) {
    return (
      <s-page heading={job}>
        <s-scroll-box>
          <s-stack direction="block" gap="base">
            {error ? <s-text tone="critical">{error}</s-text> : <s-text>Loading…</s-text>}
            <s-button onClick={() => go({ name: 'home' })}>Back</s-button>
          </s-stack>
        </s-scroll-box>
      </s-page>
    );
  }

  const m = t.money;
  const closed = t.status === 'completed' || t.status === 'cancelled';
  const tone = t.status === 'ready_for_pickup' ? 'success' : closed ? 'neutral' : 'info';

  return (
    <s-page heading={t.jobNumber}>
      <s-scroll-box>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-badge tone={tone}>{t.statusLabel}</s-badge>
            {t.needsReview && <s-badge tone="warning">Check</s-badge>}
          </s-stack>
          {t.needsReview && t.reviewNote && <s-text tone="warning">{t.reviewNote}</s-text>}
          <s-text>{`${t.customer.name}${t.customer.phone ? ` · ${t.customer.phone}` : ''}`}</s-text>
          <s-text>{`${t.board} — ${t.repair}`}</s-text>
          {t.notes && <s-text>{`Notes: ${t.notes}`}</s-text>}
          <s-text>{`Checked in by ${t.acceptedBy || '—'} · repairer ${t.partner}`}</s-text>

          {!closed && (
            <s-section heading="Next step">
              <s-stack direction="block" gap="small">
                {['received', 'inspected', 'awaiting_approval'].includes(t.status) && (
                  <s-button variant="primary" disabled={busy} onClick={() => act('status', { to: 'at_partner' }, 'With Keith')}>Keith picked it up</s-button>
                )}
                {t.status === 'at_partner' && (
                  <s-button variant="primary" disabled={busy} onClick={() => act('status', { to: 'back_from_partner' }, 'Back from Keith')}>Back from Keith</s-button>
                )}
                {t.status === 'back_from_partner' && (
                  <s-stack direction="inline" gap="base">
                    <s-button variant="primary" disabled={busy} onClick={() => act('status', { to: 'ready_for_pickup', call: 'spoke', note: 'Told customer it is ready' }, 'Ready for pickup')}>Called: spoke</s-button>
                    <s-button variant="primary" disabled={busy} onClick={() => act('status', { to: 'ready_for_pickup', call: 'left_message', note: 'Left message: ready for pickup' }, 'Ready for pickup')}>Called: left message</s-button>
                    <s-button disabled={busy} onClick={() => act('status', { to: 'ready_for_pickup', call: 'texted', note: 'Texted: ready for pickup' }, 'Ready for pickup')}>Texted</s-button>
                  </s-stack>
                )}
                {t.status === 'ready_for_pickup' && (
                  <s-stack direction="block" gap="small">
                    <s-button variant="primary" disabled={busy || !(m.price > 0)} onClick={addToCart}>{`Add to cart · ${money(m.balance ?? m.price)}`}</s-button>
                    <s-text>After the customer pays at the register:</s-text>
                    <s-button disabled={busy} onClick={async () => {
                      if (m.balance > 0) await act('payment', { amount: (m.balance / 100).toFixed(2), method: 'cash', note: 'Paid at POS' });
                      await act('status', { to: 'completed' }, 'Picked up');
                    }}>{m.balance > 0 ? `Paid ${money(m.balance)} · board handed over` : 'Board handed over'}</s-button>
                  </s-stack>
                )}
              </s-stack>
            </s-section>
          )}

          <s-section heading={`Price ${money(m.price)} · owes ${money(m.balance)}`}>
            <s-stack direction="block" gap="small">
              <s-text>{`Keith ${money(m.partnerCharge)} + MOKU fee ${money(m.shopFee)}${m.agreedPrice !== null ? ` · agreed ${money(m.agreedPrice)}` : ''} · paid ${money(m.paid)}`}</s-text>
              {!closed && (
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="base">
                    <s-text-field label="Keith's charge ($)" value={charge} onInput={(e) => setCharge(e.currentTarget.value)} />
                    <s-text-field label="MOKU fee ($)" value={fee} onInput={(e) => setFee(e.currentTarget.value)} />
                    <s-text-field label="Agreed price ($, optional)" value={agreed} onInput={(e) => setAgreed(e.currentTarget.value)} />
                  </s-stack>
                  <s-text>Agreed price replaces Keith + fee. Leave it blank to use Keith + fee.</s-text>
                  <s-button disabled={busy} onClick={() => act('price', { partnerCharge: charge.trim() || null, shopFee: fee.trim() || '0', agreedPrice: agreed.trim() || null }, 'Price saved')}>Save price</s-button>
                </s-stack>
              )}
            </s-stack>
          </s-section>

          {!closed && (
            <s-section heading="Calls">
              <s-stack direction="block" gap="small">
                <s-text-field label="Note (optional)" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
                <s-stack direction="inline" gap="base">
                  <s-button disabled={busy} onClick={() => act('call', { outcome: 'left_message', note }, 'Call logged').then(() => setNote(''))}>Left message</s-button>
                  <s-button disabled={busy} onClick={() => act('call', { outcome: 'spoke', note }, 'Call logged').then(() => setNote(''))}>Spoke</s-button>
                  <s-button disabled={busy} onClick={() => act('call', { outcome: 'texted', note }, 'Text logged').then(() => setNote(''))}>Texted</s-button>
                </s-stack>
              </s-stack>
            </s-section>
          )}
          {t.calls.length > 0 && (
            <s-stack direction="block" gap="small">
              {t.calls.map((c, i) => (
                <s-text key={i}>{`${new Date(c.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${c.by || ''} · ${{ left_message: 'Left message', spoke: 'Spoke', texted: 'Texted', no_answer: 'No answer', note: 'Note' }[c.outcome]}${c.note ? ` · ${c.note}` : ''}`}</s-text>
              ))}
            </s-stack>
          )}

          {error && <s-text tone="critical">{error}</s-text>}
          <s-stack direction="inline" gap="base">
            <s-button disabled={busy} onClick={() => act('reprint', {}, 'Label sent')}>Reprint label</s-button>
            <s-button onClick={() => go({ name: 'home' })}>Done</s-button>
          </s-stack>
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}

// ---------------------------------------------------------------- settings
// Owners only: the default MOKU fee for new jobs, and who works the desk.

function Settings({ go }) {
  const [data, setData] = useState(null);
  const [fee, setFee] = useState('');
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState(null); // staff id waiting for a second tap
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const show = (d) => {
    setData(d);
    setFee((d.defaultShopFee / 100).toFixed(2));
  };
  useEffect(() => {
    api('/api/settings').then(show).catch((e) => setError(e.message));
  }, []);

  async function run(path, body, done) {
    setError('');
    setBusy(true);
    try {
      show(await api(path, body));
      setConfirm(null);
      if (done) toast(done);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <s-page heading="Settings">
      <s-scroll-box>
        <s-stack direction="block" gap="base">
          {!data && !error && <s-text>Loading…</s-text>}
          {data && (
            <s-section heading="Default MOKU fee">
              <s-stack direction="block" gap="small">
                <s-text>Added on top of Keith's charge for every new check-in. Jobs already checked in keep their fee.</s-text>
                <s-stack direction="inline" gap="base">
                  <s-text-field label="Fee ($)" value={fee} onInput={(e) => setFee(e.currentTarget.value)} />
                  <s-button disabled={busy} onClick={() => run('/api/settings/fee', { fee: fee.trim() }, 'Default fee saved')}>Save fee</s-button>
                </s-stack>
              </s-stack>
            </s-section>
          )}
          {data && (
            <s-section heading={`Staff · ${data.staff.length}`}>
              <s-stack direction="block" gap="small">
                {data.staff.map((s) => (
                  <s-stack key={s.id} direction="inline" gap="base">
                    <s-text>{`${s.name}${s.owner ? ' · owner' : ''}${s.linked ? '' : ' · not set up on POS yet'}`}</s-text>
                    {s.linked && !s.me && (
                      <s-button disabled={busy} onClick={() => run(`/api/settings/staff/${s.id}/reset-link`, {}, `${s.name} will pick their name again`)}>Reset POS link</s-button>
                    )}
                    {!s.me && (confirm === s.id ? (
                      <s-button tone="critical" disabled={busy} onClick={() => run(`/api/settings/staff/${s.id}/remove`, {}, `${s.name} removed`)}>{`Tap again to remove ${s.name}`}</s-button>
                    ) : (
                      <s-button disabled={busy} onClick={() => setConfirm(s.id)}>Remove</s-button>
                    ))}
                  </s-stack>
                ))}
                <s-stack direction="inline" gap="base">
                  <s-text-field label="New staff name" value={name} onInput={(e) => setName(e.currentTarget.value)} />
                  <s-button disabled={busy || !name.trim()} onClick={async () => { if (await run('/api/settings/staff', { name: name.trim() }, `${name.trim()} added`)) setName(''); }}>Add</s-button>
                </s-stack>
                <s-text>Removed staff stay on the jobs they handled. New staff pick their name the first time they open the Repair Desk.</s-text>
              </s-stack>
            </s-section>
          )}
          {error && <s-text tone="critical">{error}</s-text>}
          <s-button onClick={() => go({ name: 'home' })}>Done</s-button>
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}
