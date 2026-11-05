# Chipo-Ai Project Team Roles

This document defines five team roles for planning, building, testing, and delivering the Chipo-Ai university chatbot. One person may cover more than one role on a small team.

## 1. Project Manager and Requirements Analyst

- Coordinate the project schedule, tasks, meetings, and progress updates.
- Gather requirements from students, university staff, and other stakeholders.
- Prioritize features such as answering university questions, student access, and staff support.
- Track risks and decisions, and make sure the team agrees on what is in and out of scope.
- **Main deliverables:** project schedule, requirements, task assignments, and status updates.

## 2. User Interface and Experience Developer

- Design and build the student chat experience and staff dashboard.
- Keep the interface clear, accessible, and usable on desktop and mobile devices.
- Present chatbot responses, suggested questions, ticket status, and helpful error messages.
- Work with the backend developer to connect pages to application endpoints.
- **Main deliverables:** chat interface, staff-facing screens, and responsive UI updates.

## 3. Chatbot and Knowledge Integration Developer

- Configure the chatbot's response flow and AI-provider integration.
- Organize and maintain FAQs and university reference documents used to answer questions.
- Improve retrieval and answer quality, including clear handling when the chatbot cannot find an answer.
- Work with staff to review and update university information.
- **Main deliverables:** chatbot behavior, knowledge content, and answer-quality checks.

## 4. Backend and Authentication Developer

- Implement server routes and business logic for chat, student access, staff access, and support tickets.
- Maintain authentication and authorization behavior for student and staff features.
- Validate incoming data and return consistent, useful errors to the interface.
- Coordinate with the database role on data access and with the chatbot role on AI requests.
- **Main deliverables:** server-side features, access flows, and API documentation or endpoint notes.

## 5. Database, Quality Assurance, and Deployment Engineer

- Maintain the database schema and data access for supported MySQL and Turso setups.
- Test key workflows, including login, question answering, ticket submission, and staff operations.
- Track defects, verify fixes, and check that changes do not break existing behavior.
- Maintain deployment configuration and setup guidance; keep credentials and other secrets out of source control.
- **Main deliverables:** database changes, test results, deployment configuration, and setup documentation.

## Team Coordination

- Agree on feature requirements before implementation and review changes before release.
- Share progress and blockers regularly; document decisions that affect other roles.
- Test the complete student and staff workflows together before deploying an update.
