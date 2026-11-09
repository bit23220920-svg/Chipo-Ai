// mailer.js
//
// Optional email notifications. Nothing is sent unless SMTP is configured:
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, MAIL_FROM
// A failed send is logged and never breaks the request that triggered it.

const nodemailer = require('nodemailer');

let transporter = null;
let overrideTransport = null;

function configured() {
  return Boolean(overrideTransport || process.env.SMTP_HOST);
}

function getTransport() {
  if (overrideTransport) return overrideTransport;
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
      connectionTimeout: 10000,
      socketTimeout: 15000,
    });
  }
  return transporter;
}

/** For tests: replace the transport (an object with sendMail) or pass null to reset. */
function setTransport(transport) {
  overrideTransport = transport || null;
  transporter = null;
}

async function send({ to, subject, text }) {
  const transport = getTransport();
  if (!transport || !to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to))) return false;
  try {
    await transport.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER || 'chipo@localhost',
      to,
      subject,
      text,
    });
    return true;
  } catch (err) {
    console.error('Could not send the email:', err.message);
    return false;
  }
}

const STATUS_WORDS = { opened: 'Opened', in_progress: 'In Progress', resolved: 'Resolved' };

function ticketCreated(ticket) {
  const office = ticket.departmentName || 'the university team';
  return send({
    to: ticket.email,
    subject: `Chipo: your request ${ticket.id} has been received`,
    text: `Hello${ticket.name ? ' ' + ticket.name : ''},\n\nYour request has been passed to ${office}.\nReference: ${ticket.id}\nPriority: ${ticket.priorityLabel || 'Medium'}\n\nYou can ask Chipo for the status at any time using this reference.\n\nUNILUS Chipo`,
  });
}

function ticketStatusChanged(ticket, note) {
  const word = STATUS_WORDS[ticket.status] || ticket.status;
  return send({
    to: ticket.email,
    subject: `Chipo: your request ${ticket.id} is now ${word}`,
    text: `Hello${ticket.name ? ' ' + ticket.name : ''},\n\nYour request ${ticket.id}${ticket.departmentName ? ' (' + ticket.departmentName + ')' : ''} is now ${word}.${note ? '\n\nNote from staff: ' + note : ''}\n\nUNILUS Chipo`,
  });
}

module.exports = { configured, send, setTransport, ticketCreated, ticketStatusChanged };
