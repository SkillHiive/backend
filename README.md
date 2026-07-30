<img width="1983" height="793" alt="SkillHiive Banner" src="https://github.com/user-attachments/assets/c5f7801e-c4f7-4db1-9f69-f79653b9bccf" />

# SkillHiive Backend

> The trusted services behind SkillHiive.

This repository contains the backend services powering the SkillHiive ecosystem.

It provides the secure infrastructure responsible for authentication, authorization, real-time communication, and integrations that support the SkillHiive platform.

Unlike the frontend, this repository is **not intended to be a standalone application**. It exists to securely power the client applications while keeping sensitive credentials and business logic off the client.

---

# Responsibilities

The backend currently handles:

* Authentication validation
* Secure token generation
* Real-time service integrations
* API endpoints
* Backend-only secrets
* Platform infrastructure

As SkillHiive evolves, additional backend services may be introduced while maintaining a modular architecture.

---

# Technology

Current technologies include:

* Node.js
* Express
* Supabase
* LiveKit
* REST APIs

The technology stack may evolve as the platform grows.

---

# Development

## Prerequisites

* Node.js (Latest LTS recommended)
* npm
* Supabase project
* LiveKit server

---

## Installation

```bash
git clone https://github.com/<org>/backend.git

cd backend

npm install
```

---

## Environment Variables

Create a `.env` file containing the required configuration.

Example:

```env
SUPABASE_URL=

SUPABASE_SERVICE_ROLE_KEY=

LIVEKIT_API_KEY=

LIVEKIT_API_SECRET=
```

Never commit your `.env` file or expose service credentials publicly.

---

## Running Locally

```bash
npm run dev
```

or

```bash
npm start
```

The backend will start using the configured environment variables.

---

# Security

This repository is responsible for handling sensitive operations.

Some principles followed throughout the project include:

* Secrets remain server-side.
* Authentication is verified before privileged operations.
* Short-lived tokens are preferred over long-lived credentials.
* Client applications never receive backend service secrets.

If you discover a security vulnerability, please refer to our Security Policy.

---

# Project Structure

```
backend/
├── server.js
└── ...
```

The structure may change as the project evolves.

---

# Contributing

Contributions are welcome.

Before opening a Pull Request, please read our Contributing Guide and ensure your changes align with the project's philosophy and coding standards.

---

# Documentation

Additional documentation can be found in the `docs/` directory.

Topics include:

* Architecture
* Authentication
* API Reference
* Deployment
* Development

---

# License

Licensed under the GNU Affero General Public License v3.0 (AGPLv3).

See the LICENSE file for details.

---

# About SkillHiive

SkillHiive is building communities around presence instead of performance.

No algorithms.

No performance systems.

Just real people, real connections, and meaningful work.

Learn more about the project through the SkillHiive organization.
