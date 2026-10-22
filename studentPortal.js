// studentPortal.js
//
// Content behind the student portal dashboard: the left-rail service menu,
// the announcements panel and the timetable links table.
//
// The service menu is static (it mirrors the university's SIS menu) and each
// entry hands the student straight to Chipo with the right question. The
// announcements and timetable links live in the database.

const crypto = require('crypto');
const { query } = require('./db.js');

// Portal service menu, in the order the university lists it.
const PORTAL_SERVICES = [
  ['home', 'Home'],
  ['elearning', 'E-learning'],
  ['course-registration', 'Course registration'],
  ['quotations', 'Quotations'],
  ['graduation-confirmation', 'Graduation Confirmation'],
  ['personal-information', 'Personal Information'],
  ['student-appeal', 'Student appeal submit'],
  ['class-pass', 'Class Pass'],
  ['payments', 'Payments'],
  ['accounts-switch', 'Accounts Switch'],
  ['exemptions-apply', 'Exemptions Apply'],
  ['graduation-clearance', 'Graduation clearance tracker'],
  ['deferment', 'Apply for Deferment'],
].map(([key, label]) => ({ key, label }));

// Sample records shown for each service. `facts` renders as a key/value
// summary, `columns` + `rows` render as a table.
const SERVICE_SAMPLE_DATA = {
  elearning: {
    intro: 'Course materials uploaded to your e-learning account for 2026 Semester 2.',
    columns: ['Course Code', 'Course Name', 'Lecturer', 'Materials'],
    rows: [
      ['BIT101', 'Introduction to Programming', 'Dr. M. Phiri', '12 files'],
      ['BIT102', 'Computer Networks', 'Ms. T. Kalaba', '9 files'],
      ['BIT103', 'Database Systems', 'Mr. C. Mutale', '14 files'],
      ['BIT104', 'Software Engineering', 'Dr. L. Mwansa', '8 files'],
      ['MGT105', 'Communication Skills', 'Ms. R. Chileshe', '6 files'],
    ],
  },
  'course-registration': {
    intro: 'Courses registered for 2026 Semester 2.',
    facts: { 'Total credits': '19', 'Registration status': 'Registered', 'Last updated': '04 Sep 2026' },
    columns: ['Course Code', 'Course Name', 'Credits', 'Status'],
    rows: [
      ['BIT101', 'Introduction to Programming', '4', 'Registered'],
      ['BIT102', 'Computer Networks', '4', 'Registered'],
      ['BIT103', 'Database Systems', '4', 'Registered'],
      ['BIT104', 'Software Engineering', '3', 'Registered'],
      ['MGT105', 'Communication Skills', '3', 'Pending approval'],
    ],
  },
  quotations: {
    intro: 'Quotation of charges billed to your student account.',
    columns: ['Description', 'Amount (ZMW)', 'Status'],
    rows: [
      ['Tuition fee — 2026 Semester 2', '18,500.00', 'Billed'],
      ['Registration fee', '1,200.00', 'Billed'],
      ['Library levy', '850.00', 'Paid'],
      ['Student levy', '600.00', 'Paid'],
      ['Total outstanding', '15,150.00', 'Payment due'],
    ],
  },
  'graduation-confirmation': {
    intro: 'Your graduation record. Confirm your details before the closing date.',
    facts: {
      Programme: 'BSc Computer Science',
      Faculty: 'School of Technology and Social Sciences',
      'Expected graduation': 'October 2026',
      Ceremony: '20th Graduation Ceremony — 22 & 23 October 2026',
      'Invitation issued': 'Yes',
      'Confirmation status': 'Not yet confirmed',
    },
    columns: ['Step', 'Owner', 'Status'],
    rows: [
      ['Academic record verified', 'Registry', 'Complete'],
      ['Fees and dues cleared', 'Accounts Office', 'Outstanding'],
      ['Graduation confirmation submitted', 'Student', 'Pending'],
    ],
  },
  'personal-information': {
    intro: 'Personal details the university holds for you. Contact the Registry to correct any entry.',
    facts: {
      'Full name': 'John Sichula',
      'Student number': 'BIT23220920',
      Programme: 'BSc Computer Science',
      Faculty: 'School of Technology and Social Sciences',
      'Year of study': 'Year 2',
      'Date of birth': '14 March 2004',
      Nationality: 'Zambian',
      'Entry date': '09 September 2024',
      Email: 'john.sichula@student.unilus.edu.zm',
      Phone: '+260 97X XXX XXX',
      'Home address': 'Lusaka, Zambia',
      'Account status': 'Active',
    },
  },
  'student-appeal': {
    intro: 'Appeals you have submitted and their current status.',
    columns: ['Reference', 'Subject', 'Submitted', 'Status'],
    rows: [
      ['APL-2026-0142', 'Deferred examination sitting', '12 Sep 2026', 'Under review'],
      ['APL-2026-0118', 'Course registration correction', '28 Aug 2026', 'Approved'],
      ['APL-2026-0097', 'Marking of CA assignment 3', '14 Aug 2026', 'Closed'],
    ],
  },
  'class-pass': {
    intro: 'Class passes issued to you for field trips, industrial visits and clinical rotations.',
    columns: ['Reference', 'Destination', 'Date', 'Status'],
    rows: [
      ['CP-2026-021', 'Copperbelt Mining Company, Ndola', '24 Oct 2026', 'Approved'],
      ['CP-2026-018', 'Teaching Hospital clinical rotation', '17 Oct 2026', 'Approved'],
      ['CP-2026-015', 'Zambia Statistics Agency', '03 Oct 2026', 'Expired'],
    ],
  },
  payments: {
    intro: 'Payments received against your student account.',
    facts: { 'Total paid': '6,000.00 ZMW', 'Total outstanding': '15,150.00 ZMW', 'Account status': 'Active' },
    columns: ['Receipt', 'Description', 'Date', 'Amount (ZMW)'],
    rows: [
      ['RCP-88214', 'Tuition fee — Semester 2', '12 Sep 2026', '3,350.00'],
      ['RCP-87990', 'Registration fee', '05 Sep 2026', '1,200.00'],
      ['RCP-87455', 'Library levy', '02 Sep 2026', '850.00'],
      ['RCP-87011', 'Student levy', '02 Sep 2026', '600.00'],
    ],
  },
  'accounts-switch': {
    intro: 'Student accounts you can switch to.',
    columns: ['Student Number', 'Programme', 'Year', 'Status'],
    rows: [
      ['BIT23220920', 'BSc Computer Science', 'Year 2', 'Active'],
      ['BIT22981455', 'Diploma in Information Technology', 'Year 3', 'Active'],
      ['BIT22710038', 'BSc Computer Science', 'Year 4', 'Inactive'],
    ],
  },
  'exemptions-apply': {
    intro: 'Exemptions you may apply for. Choose one to start an application.',
    publicGuide: {
      columns: ['Exemption type', 'Evidence required', 'Processing time'],
      rows: [
        ['Staff / staff dependant', 'Staff certificate and dependant ID', '5 working days'],
        ['Medical grounds', 'Medical report from a registered practitioner', '7 working days'],
        ['Academic merit', 'Transcript and academic award letter', '10 working days'],
        ['Hardship', 'Written hardship statement and proof of income', '10 working days'],
      ],
    },
    columns: ['Exemption type', 'Evidence required', 'Processing time'],
    rows: [
      ['Staff / staff dependant', 'Staff certificate and dependant ID', '5 working days'],
      ['Medical grounds', 'Medical report from a registered practitioner', '7 working days'],
      ['Academic merit', 'Transcript and academic award letter', '10 working days'],
      ['Hardship', 'Written hardship statement and proof of income', '10 working days'],
    ],
  },
  'graduation-clearance': {
    intro: 'Each unit that must clear your record before graduation.',
    publicGuide: {
      columns: ['Department / Unit'],
      rows: [
        ['Faculty of Science & Technology'],
        ['Department of Computing'],
        ['Library'],
        ['ICT Services'],
        ['Student Affairs'],
        ['Accounts Office'],
      ],
    },
    columns: ['Department / Unit', 'Status', 'Date cleared'],
    rows: [
      ['Faculty of Science & Technology', 'Cleared', '08 Oct 2026'],
      ['Department of Computing', 'Cleared', '06 Oct 2026'],
      ['Library', 'Cleared', '03 Oct 2026'],
      ['ICT Services', 'Cleared', '09 Oct 2026'],
      ['Student Affairs', 'Cleared', '07 Oct 2026'],
      ['Accounts Office', 'Outstanding', '—'],
    ],
  },
  deferment: {
    intro: 'Deferring your studies moves you to a later intake. Your current record stays on the system.',
    publicGuide: {
      columns: ['Reason for deferment', 'Supporting document'],
      rows: [
        ['Health / medical', 'Medical report'],
        ['Financial hardship', 'Statement and proof of income'],
        ['Academic / professional', 'Employer confirmation or academic transcript'],
        ['Personal / family', 'Written explanation'],
      ],
    },
    facts: {
      'Current intake': '2026 Semester 2',
      'Proposed intake': '2027 Semester 1',
      'Application status': 'Not applied',
      'Deadline for applications': '30 November 2026',
    },
    columns: ['Reason for deferment', 'Supporting document'],
    rows: [
      ['Health / medical', 'Medical report'],
      ['Financial hardship', 'Statement and proof of income'],
      ['Academic / professional', 'Employer confirmation or academic transcript'],
      ['Personal / family', 'Written explanation'],
    ],
  },
};

const DEFAULT_ANNOUNCEMENTS = [
  {
    title: 'IMPORTANT REGISTRATION NOTICE TO ALL STUDENTS',
    body: 'Attendance and participation in classes by unregistered students.\n\nDear Students,\n\nThe University wishes to remind all students that registration is a mandatory requirement for participation in academic activities. Students who are not registered are not permitted to sit for examinations.\n\nPlease complete your registration through the portal and confirm that your registration status shows as Active.',
    category: 'Registration',
    isImportant: true,
    publishedAt: '2026-09-18 12:08:00',
  },
  {
    title: 'IMPORTANT GRADUATION NOTICE — 20TH GRADUATION CEREMONY',
    body: '1.0 Invitation to the 20th Graduation Ceremony.\n\nManagement of the University of Lusaka is pleased to invite the October 2026 graduating students to the 20th Graduation Ceremony.\n\nPlease confirm your attendance and the number of guests you are bringing through the Graduation Confirmation page on the portal.',
    category: 'Graduation',
    isImportant: true,
    publishedAt: '2026-08-04 08:04:00',
  },
  {
    title: 'NOTICE TO ALL UNDERGRADUATE STUDENTS RE: SUSPENSION OF CLASSES',
    body: 'All undergraduate students are hereby informed that there will be no classes on Thursday, 22nd and Friday, 23rd October 2026, due to the University\'s 20th Graduation Ceremony.\n\nTeaching resumes as normal on Monday, 26th October 2026.',
    category: 'Academic',
    isImportant: false,
    publishedAt: '2026-10-21 18:21:00',
  },
  {
    title: 'NOTICE TO GRADUATING STUDENTS',
    body: 'The Graduation Clearance Process is now fully online. Graduating students are no longer required to download, print, or move between departments with signed documents.\n\nUse the Graduation Clearance Tracker on the portal to see which departments have cleared your record.',
    category: 'Graduation',
    isImportant: false,
    publishedAt: '2026-10-06 12:25:00',
  },
  {
    title: 'Student Code of Conduct',
    body: 'The University of Lusaka (hereinafter referred to as "UNILUS" or "the University") was established as a centre of excellence dedicated to delivering academic and professional training.\n\nThe Student Code of Conduct sets out the standards of behaviour expected of every registered student and the disciplinary procedures that follow any breach.',
    category: 'Governance',
    isImportant: false,
    publishedAt: '2026-08-28 16:24:00',
  },
];

const DEFAULT_TIMETABLES = [
  'BSPH - Students', 'DIPLOMA - POSTGRADUATE', 'DIPLOMA - NURSING',
  'DIPLOMA - NURSING LECTURER', 'DISTANCE - POSTGRADUATE', 'LAW',
  'Lecturer', 'Medicine Lecturer', 'Medicine Student', 'Postgraduate - Part time',
  'ROOMS', 'Rooms', 'School of Business - Student', 'TECHNOLOGY AND SOCIAL SCIENCES',
];

function rowToAnnouncement(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    category: row.category || null,
    isImportant: !!row.is_important,
    publishedAt: row.published_at,
  };
}

function rowToTimetable(row) {
  return {
    id: row.id,
    name: row.name,
    academicYear: row.academic_year,
    semester: row.semester,
    url: row.url || null,
  };
}

async function listAnnouncements({ limit = 5 } = {}) {
  const { rows } = await query(`SELECT * FROM announcements ORDER BY published_at DESC LIMIT ${Number(limit) || 5}`);
  return rows.map(rowToAnnouncement);
}

async function listTimetables() {
  const { rows } = await query('SELECT * FROM portal_timetables WHERE is_active = $1 ORDER BY name ASC', [true]);
  return rows.map(rowToTimetable);
}

async function countAnnouncements() {
  const { rows } = await query('SELECT COUNT(*) AS total FROM announcements');
  return Number(rows[0]?.total || 0);
}

async function listServices() {
  return PORTAL_SERVICES.map((service) => ({ ...service, sample: SERVICE_SAMPLE_DATA[service.key] || null }));
}

/** Seed the portal with the standard announcements and timetable links once. */
async function ensureDefaultPortalContent() {
  const { rows: announcementRows } = await query('SELECT COUNT(*) AS total FROM announcements');
  if (Number(announcementRows[0]?.total || 0) === 0) {
    for (const item of DEFAULT_ANNOUNCEMENTS) {
      await query(
        `INSERT INTO announcements (id, title, body, category, is_important, published_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [crypto.randomUUID(), item.title, item.body, item.category, item.isImportant, item.publishedAt]
      );
    }
  }

  const { rows: timetableRows } = await query('SELECT COUNT(*) AS total FROM portal_timetables');
  if (Number(timetableRows[0]?.total || 0) === 0) {
    for (const name of DEFAULT_TIMETABLES) {
      await query(
        `INSERT INTO portal_timetables (id, name, academic_year, semester, is_active) VALUES ($1, $2, $3, $4, $5)`,
        [crypto.randomUUID(), name, '2026', '2', true]
      );
    }
  }
}

/**
 * The records Chipo is allowed to read, split by who is asking.
 * Without a student the payload only carries public material (notices,
 * published timetable links, what each service is for). With a student it
 * also carries that student's own portal records.
 * @param {object|null} student
 */
async function getContextPayload(student = null) {
  const [announcements, timetables, services] = await Promise.all([
    listAnnouncements({ limit: 5 }),
    listTimetables(),
    listServices(),
  ]);
  return { student: student || null, announcements, timetables, services };
}

/** Everything the portal dashboard needs, in one payload. */
async function getPortalData(student) {
  const [announcements, timetables, services, announcementCount] = await Promise.all([
    listAnnouncements({ limit: 5 }),
    listTimetables(),
    listServices(),
    countAnnouncements(),
  ]);
  return {
    profile: {
      studentNumber: student.studentNumber,
      fullName: student.fullName,
      role: student.role,
      programme: student.programme,
      faculty: student.faculty,
      yearOfStudy: student.yearOfStudy,
      email: student.email,
      phone: student.phone,
      status: student.status,
    },
    announcements,
    announcementCount,
    timetables,
    services,
  };
}

module.exports = {
  PORTAL_SERVICES,
  SERVICE_SAMPLE_DATA,
  listAnnouncements,
  countAnnouncements,
  listTimetables,
  listServices,
  ensureDefaultPortalContent,
  getContextPayload,
  getPortalData,
};
