# Chipo-Ai Technical Project Plan

## 1. Project Overview

Chipo-Ai is a university information and student-support web application. It combines a public chatbot, a signed-in student portal, staff administration, and a support-ticket workflow. The assistant uses university FAQs and reference material to answer general questions, and can use a signed-in student's permitted portal records to answer personal account questions.

This document describes the technical scope and assigns the work to the same five roles listed in [PROJECT_ROLES.md](./PROJECT_ROLES.md). It reflects the current project structure while also identifying the engineering and verification work needed to deliver changes reliably.

## 2. Complexity Assessment

**Overall complexity: High (4 out of 5).**

The application is more involved than a standalone FAQ bot because it combines:

- Multiple user experiences: public chat, student portal, and staff dashboard.
- Separate student and staff authentication and authorization.
- AI-assisted answers grounded in FAQs and university reference content.
- Protected access to personal student information.
- Ticket creation, department routing, and staff ticket management.
- Persistent conversation history and portal data in a relational database.
- Two supported database configurations: MySQL/MariaDB and Turso/libSQL.
- External AI services, deployment configuration, and secret management.

The rating describes the integration and testing effort; it does not mean every feature must be built from scratch. Existing files already implement many of these capabilities.

## 3. Technical Architecture

### Application layers

1. **Web interface:** Browser-based public chat, student portal, and staff dashboard in `public/`.
2. **HTTP application:** Node.js and Express in `server.js`, serving the web files and API routes.
3. **Application services:** Focused modules handle AI answering, retrieval, authentication, portal context, FAQs, ticket routing, attachments, and logging.
4. **Data access:** `db.js` selects Turso/libSQL when configured; otherwise it uses MySQL/MariaDB.
5. **External services and content:** Gemini powers embeddings and chatbot requests; university reference files are stored in `content/`. Anthropic's SDK is also present in the dependencies.

### Main request flow

1. A student or visitor submits a question through the appropriate chat interface.
2. The browser sends the request to the public `/ask` route or the authenticated `/portal/ask` route.
3. The server applies the relevant access rules, loads permitted context, and prepares the question for answering.
4. The chatbot uses FAQ/reference retrieval and AI integration to produce a response.
5. The server stores conversation data and, when human support is needed or requested, can create a ticket for staff follow-up.
6. Authorized staff manage tickets and related university content through protected admin routes.

### Data and integrations

The database schema includes staff users, students, departments, FAQs, tickets, chat messages and conversations, announcements, timetables, and system logs. Database schemas for MySQL and Turso are maintained separately. Environment variables configure the database, JWT signing, and AI provider credentials.

## 4. Technical Scope

### Core capabilities

- Public university-question chat.
- Student registration/login and a protected portal experience.
- Student-specific answers restricted to the signed-in student's permitted records.
- FAQ and university-document knowledge sources.
- Conversation history for follow-up questions.
- Support-ticket submission, department routing, and staff ticket status updates.
- Staff sign-in and protected administration of supported content.
- MySQL/MariaDB and Turso/libSQL database configurations.
- Deployment and health-check support.

### Quality requirements

- **Privacy:** Public requests must not expose student-specific portal records.
- **Authorization:** Student and staff routes must enforce the appropriate identity and role.
- **Reliability:** Database, AI provider, and malformed-request errors should be handled clearly.
- **Answer quality:** Responses should use university sources where possible and indicate when human assistance is needed.
- **Maintainability:** Keep responsibilities separated into existing modules and maintain matching database schemas.
- **Deployability:** Document required environment configuration and ensure secrets are not committed.

## 5. Roles and Technical Responsibilities

### 1. Project Manager and Requirements Analyst

- Confirm scope, acceptance criteria, milestones, and dependencies with university stakeholders.
- Prioritize work across public chat, portal, staff administration, and support tickets.
- Maintain a risk and decision log, especially for student-data access and approved knowledge sources.
- Coordinate reviews and verify that each feature has an agreed completion criterion.
- **Technical outputs:** requirements, acceptance criteria, prioritized backlog, release checklist.

### 2. User Interface and Experience Developer

- Maintain the browser interfaces in `public/` for the public site, student portal, and staff dashboard.
- Connect screens to the correct API routes and preserve the distinction between public and authenticated portal chat.
- Provide clear loading, empty, validation, error, and ticket-status states.
- Check responsive layout, keyboard access, and understandable authentication feedback.
- **Technical outputs:** user-facing features, API integration, responsive and accessibility checks.

### 3. Chatbot and Knowledge Integration Developer

- Maintain the question-answering flow and AI-provider integration in the chatbot modules.
- Prepare and maintain FAQ and document knowledge sources; verify document extraction and retrieval quality.
- Test that answers are relevant, uncertainty is handled appropriately, and unanswered questions can be escalated.
- Coordinate safe use of student context with the backend role.
- **Technical outputs:** retrieval and prompt changes, knowledge-source updates, representative answer evaluations.

### 4. Backend and Authentication Developer

- Maintain Express routes and service logic for chat, authentication, portal access, and ticket workflows.
- Enforce student/staff authorization on the server, not only in the browser.
- Validate request data and preserve consistent behavior across API routes.
- Coordinate with the database role on persistence and with the chatbot role on context boundaries.
- **Technical outputs:** API and service changes, authentication/access checks, route-level tests.

### 5. Database, Quality Assurance, and Deployment Engineer

- Maintain `schema.sql`, `schema.turso.sql`, migrations, and the shared data-access behavior.
- Verify important workflows against both configured database options where practical.
- Run regression checks for authentication, chat, portal access, FAQ management, and ticket processing.
- Maintain deployment configuration and setup instructions, and verify environment/secret handling.
- **Technical outputs:** schema and migration updates, test evidence, deployment updates, release verification.

## 6. Suggested Delivery Stages

| Stage | Work | Lead roles | Completion check |
|---|---|---|---|
| 1. Requirements and technical review | Confirm scope, inspect existing workflows, define acceptance criteria | Project Manager; all roles | Approved scope and testable requirements |
| 2. Data and service foundations | Review schemas, configuration, API contracts, and access boundaries | Backend; Database/QA | Application starts and data access works in the target environment |
| 3. Chat and knowledge | Verify knowledge sources, retrieval, AI responses, and handoff behavior | Chatbot; Backend | Representative questions return grounded answers or a clear escalation |
| 4. Student and staff interfaces | Complete page flows and connect them to protected and public APIs | UI/UX; Backend | Student, visitor, and staff journeys work end to end |
| 5. Verification and release | Run regression/security-boundary checks, deployment rehearsal, and documentation review | Database/QA; all roles | Critical workflows pass and deployment steps are repeatable |

Stages may overlap after requirements and API contracts are agreed. The team should estimate duration after confirming the feature changes and availability of stakeholders and test data.

## 7. Main Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Student-specific data is exposed through a public or incorrectly authorized route | Enforce authorization and data scoping on the server; test public and portal routes separately |
| AI answers are inaccurate or unsupported | Maintain trusted university sources, evaluate representative questions, and make escalation behavior explicit |
| MySQL and Turso schemas or query behavior diverge | Keep both schema files aligned and run database-focused checks against each supported configuration |
| AI service or database is unavailable | Return clear errors, avoid presenting failed requests as successful answers, and document operational recovery |
| Credentials are exposed in source or deployment logs | Use environment configuration, keep `.env` out of version control, and review logs/configuration before release |
| Changes break an end-to-end user journey | Verify student, public visitor, and staff workflows after related changes |

## 8. Definition of Done

A technical change is ready when:

- Its acceptance criteria are met and its intended user flow works end to end.
- Access checks are enforced at the server boundary, particularly for student portal data.
- Relevant tests pass, and any database changes are reflected in both supported schema paths where applicable.
- Errors are visible and actionable rather than silently returned as successful results.
- Setup or deployment documentation is updated when the change affects configuration or operations.
- No credentials or other secrets are included in source changes.
