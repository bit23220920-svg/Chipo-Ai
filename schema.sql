-- MariaDB schema for the UNILUS Chipo app.
-- Create a database named `chipo` in XAMPP/phpMyAdmin, then run `node migrate.js`.

CREATE TABLE IF NOT EXISTS staff_users (
  id CHAR(36) PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  department_id CHAR(36) NULL,
  is_admin BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_staff_users_department (department_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS departments (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  contact_email VARCHAR(255),
  routing_keywords JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS faqs (
  id CHAR(36) PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  department_id CHAR(36),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  embedding JSON,
  embedded_hash VARCHAR(64),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_faqs_active (is_active),
  INDEX idx_faqs_department (department_id),
  CONSTRAINT fk_faqs_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tickets (
  id VARCHAR(20) PRIMARY KEY,
  name VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(40),
  question TEXT NOT NULL,
  conversation_summary TEXT,
  last_answer TEXT,
  confidence FLOAT,
  reason VARCHAR(30) NOT NULL DEFAULT 'manual_request',
  department_id CHAR(36),
  student_id CHAR(36) NULL,
  subject VARCHAR(255) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'opened',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tickets_status (status),
  INDEX idx_tickets_student (student_id),
  CONSTRAINT fk_tickets_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  confidence FLOAT,
  needs_human BOOLEAN NOT NULL DEFAULT FALSE,
  source VARCHAR(20) NOT NULL DEFAULT 'rag',
  student_id CHAR(36) NULL,
  student_number VARCHAR(50) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_chat_messages_session (session_id),
  INDEX idx_chat_messages_created (created_at),
  INDEX idx_chat_messages_student (student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_conversations (
  session_id VARCHAR(64) NOT NULL PRIMARY KEY,
  summary TEXT NOT NULL,
  summarized_through_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Student accounts for the student portal (/portal). Passwords are bcrypt
-- hashes; accounts are provisioned with the create-student.js CLI script.
CREATE TABLE IF NOT EXISTS students (
  id CHAR(36) PRIMARY KEY,
  student_number VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  role VARCHAR(100) NOT NULL DEFAULT 'Basic student',
  programme VARCHAR(255),
  faculty VARCHAR(255),
  year_of_study VARCHAR(50),
  email VARCHAR(255),
  phone VARCHAR(40),
  status VARCHAR(50) NOT NULL DEFAULT 'Active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS announcements (
  id CHAR(36) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  category VARCHAR(100),
  is_important BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_announcements_published (published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS portal_timetables (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  academic_year VARCHAR(20) NOT NULL,
  semester VARCHAR(20) NOT NULL,
  url VARCHAR(500),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS system_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor VARCHAR(100) NOT NULL,
  action VARCHAR(100) NOT NULL,
  detail TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_system_logs_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-student chat memory. A student has many conversations; the newest one is
-- the "current" chat. messages.role is 'user' or 'assistant'.
CREATE TABLE IF NOT EXISTS conversations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  student_id CHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_conversations_student (student_id, id),
  CONSTRAINT fk_conversations_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  conversation_id BIGINT UNSIGNED NOT NULL,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_messages_conversation (conversation_id, id),
  CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every ticket status change leaves one event, and (for tickets that belong to
-- a student) one notification for that student.
CREATE TABLE IF NOT EXISTS ticket_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  note TEXT NULL,
  staff_id CHAR(36) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ticket_events_ticket (ticket_id, id),
  CONSTRAINT fk_ticket_events_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_events_staff FOREIGN KEY (staff_id) REFERENCES staff_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  student_id CHAR(36) NOT NULL,
  ticket_id VARCHAR(20) NOT NULL,
  message VARCHAR(500) NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notifications_student (student_id, is_read, id),
  CONSTRAINT fk_notifications_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
