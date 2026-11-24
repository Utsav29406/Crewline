import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import Logo from '../components/Logo.jsx';

const UPDATED = '23 November 2026';
const CONTACT = 'teamcrewline@gmail.com';

function Section({ title, children }) {
  return (
    <section className="legal-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Privacy() {
  return (
    <>
      <p>
        Crewline is an HR and attendance service that companies use to manage their staff: attendance, leave, tasks and
        payroll. This policy explains what information Crewline holds, why, and what choices people have. If you use
        Crewline because your employer signed up, your employer decides how Crewline is used at your workplace and is
        responsible for that use; Crewline handles the information on their behalf.
      </p>

      <Section title="Information we collect">
        <ul>
          <li><b>Account details</b> your company enters or you give us: name, work email, phone, employee code, job title, department, manager, joining date, date of birth, salary and a password (stored only as a one-way hash).</li>
          <li><b>Sign in with Google.</b> If you choose it, Google shares your name, email address and a Google account ID with us. We use them only to find your Crewline account and sign you in, or, when you ask to join a company, to send that request to its HR. We don't receive your Google password, and we don't access Gmail, Drive, Contacts or any other Google data.</li>
          <li><b>Attendance:</b> check-in and check-out times, breaks, attendance status, and fix requests with their reasons.</li>
          <li><b>Location at punch-in and punch-out:</b> your device's location at the moment you check in or out, used to confirm you're inside your office area. Crewline does not track your location at any other time.</li>
          <li><b>Face check:</b> if your company uses face check-in, we store numeric face measurements made from the camera image on your device, used to match you at punch-in. We do not store the photos themselves.</li>
          <li><b>Desktop tracker</b> (only if your company asks you to install it, and only while you are checked in): periodic screenshots of your screen, whether the computer is in use or idle (not what you type), and which task you're working on.</li>
          <li><b>Work records:</b> leave requests, tasks, comments and files, documents HR uploads to your profile, payslips and announcements.</li>
          <li><b>Technical information</b> needed to run the service, such as your IP address in server logs and a sign-in token stored in your browser.</li>
        </ul>
      </Section>

      <Section title="How we use it">
        <p>
          Only to provide Crewline to your company: recording attendance and work time, working out leave and pay,
          showing your manager and HR the information they need, sending you emails about your account (such as your
          daily attendance log, sign-in codes and notifications your company turns on), keeping the service secure and
          fixing problems. We do not sell personal information, and we do not use it for advertising.
        </p>
      </Section>

      <Section title="Who can see it">
        <ul>
          <li><b>You</b> can see your own records.</li>
          <li><b>Your company's admins and HR</b> can see the records of the staff in their company. Information never crosses between companies.</li>
          <li><b>Service providers</b> that host and run Crewline for us: Vercel (website and servers), Neon (database), Vercel Blob (files and screenshots), Google Firebase Hosting (a copy of the website), Google (Sign in with Google) and Gmail (sending email). They process data only to provide their service to us.</li>
          <li><b>Authorities</b>, if the law requires us to.</li>
        </ul>
      </Section>

      <Section title="How long we keep it">
        <p>
          Desktop tracker screenshots are deleted automatically after 30 days. Other records are kept while your company
          uses Crewline, so it can meet its payroll and record-keeping duties. When your company removes an employee,
          that employee's documents, screenshots and files are deleted; when a company stops using Crewline, its data
          is deleted on request.
        </p>
      </Section>

      <Section title="Security">
        <p>
          Connections use HTTPS, passwords are hashed, files are kept in private storage reached only through
          short-lived links, and every request is limited to the signed-in person's own company. Admins can turn on an
          emailed sign-in code for extra protection.
        </p>
      </Section>

      <Section title="Your choices and rights">
        <p>
          You can ask to see, correct or delete your information. Because your employer controls your workplace
          records, start with your company's HR; you can also write to us at <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and
          we'll help or pass your request to your employer. You can stop using Sign in with Google at any time and use
          your password instead, and remove Crewline's access from your Google Account settings.
        </p>
      </Section>

      <Section title="Children">
        <p>Crewline is a workplace service and is not meant for anyone under 18.</p>
      </Section>

      <Section title="Changes">
        <p>If we change this policy we'll update the date at the top, and tell company admins about important changes.</p>
      </Section>

      <Section title="Contact">
        <p>Questions about privacy: <a href={`mailto:${CONTACT}`}>{CONTACT}</a></p>
      </Section>
    </>
  );
}

function Terms() {
  return (
    <>
      <p>
        These terms apply to everyone who uses Crewline: companies that register a workspace and the staff they add.
        By signing in or using Crewline you agree to them.
      </p>

      <Section title="The service">
        <p>
          Crewline provides attendance, leave, task, document and payroll tools on the web, as a phone app and as a
          desktop tracker. We may improve, change or add features over time.
        </p>
      </Section>

      <Section title="Accounts">
        <ul>
          <li>A company that registers is responsible for its workspace and for everyone it adds.</li>
          <li>Keep your password private. You're responsible for what happens under your account; tell your HR or us straight away if you think someone else has used it.</li>
          <li>If you use Sign in with Google, the Google account must be one you own, and its email must match the email your company gave you in Crewline.</li>
        </ul>
      </Section>

      <Section title="Company responsibilities">
        <ul>
          <li>Tell staff how Crewline is used at work, including location checks at punch-in, face check-in and the desktop tracker, and get any consent the law requires.</li>
          <li>Enter accurate information and use Crewline in line with employment, privacy and other laws that apply.</li>
          <li>Check pay and attendance figures before acting on them. Crewline calculates them from the records and settings the company provides.</li>
        </ul>
      </Section>

      <Section title="Acceptable use">
        <p>Don't misuse Crewline. In particular, don't:</p>
        <ul>
          <li>try to reach another company's data or another person's account;</li>
          <li>fake attendance, location or face checks;</li>
          <li>upload unlawful or harmful content or malware;</li>
          <li>disrupt, overload, copy or reverse-engineer the service.</li>
        </ul>
        <p>We may suspend accounts that break these terms.</p>
      </Section>

      <Section title="Your data">
        <p>
          Companies own the information they put into Crewline. We use it only to run the service, as described in
          the <Link to="/privacy">Privacy Policy</Link>.
        </p>
      </Section>

      <Section title="Availability and liability">
        <p>
          We work to keep Crewline running and accurate, but it is provided “as is”, without guarantees that it will
          always be available or error-free. To the extent the law allows, Crewline is not liable for indirect losses
          or for decisions made from its reports, and our total liability is limited to the amount the company paid
          for Crewline in the 12 months before the claim.
        </p>
      </Section>

      <Section title="Ending use">
        <p>
          A company can stop using Crewline at any time and ask us to delete its data. We may close a workspace that
          breaks these terms, after notice where reasonable.
        </p>
      </Section>

      <Section title="Changes and law">
        <p>
          We may update these terms; the date at the top shows the latest version, and continued use means you accept
          it. These terms are governed by the laws of India.
        </p>
      </Section>

      <Section title="Contact">
        <p>Questions about these terms: <a href={`mailto:${CONTACT}`}>{CONTACT}</a></p>
      </Section>
    </>
  );
}

/** Public Privacy Policy and Terms of Service pages (linked from the login page and Google's consent screen). */
export default function Legal({ page }) {
  const title = page === 'terms' ? 'Terms of Service' : 'Privacy Policy';
  useEffect(() => {
    document.title = `${title} · Crewline`;
    window.scrollTo(0, 0);
    return () => { document.title = 'Crewline'; };
  }, [title]);
  return (
    <div className="legal">
      <header className="legal-head">
        <Link to="/" className="brand" style={{ padding: 0, textDecoration: 'none', color: 'inherit' }}>
          <Logo />
          <div className="brand-name">Crewline</div>
        </Link>
        <nav className="row small" style={{ gap: 16 }}>
          <Link to="/privacy" className={page === 'privacy' ? 'active' : ''}>Privacy</Link>
          <Link to="/terms" className={page === 'terms' ? 'active' : ''}>Terms</Link>
        </nav>
      </header>
      <article className="card legal-card">
        <h1>{title}</h1>
        <p className="small muted">Last updated {UPDATED}</p>
        {page === 'terms' ? <Terms /> : <Privacy />}
      </article>
      <p className="small muted legal-foot"><Link to="/">Back to Crewline</Link></p>
    </div>
  );
}
