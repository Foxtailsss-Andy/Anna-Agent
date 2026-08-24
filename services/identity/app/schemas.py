from __future__ import annotations

from pydantic import BaseModel


class Workspace(BaseModel):
    id: str
    name: str


class Team(BaseModel):
    id: str
    workspace_id: str
    name: str


class Account(BaseModel):
    id: str
    workspace_id: str
    email: str
    display_name: str
    role: str  # "boss" | "member"
    kind: str = "human"  # "human" | "agent"


class Membership(BaseModel):
    account_id: str
    workspace_id: str
    team_id: str
    role: str


class SessionIdentity(BaseModel):
    workspace_id: str
    workspace_name: str
    user_id: str
    user_display_name: str
    role: str


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    token: str
    session: SessionIdentity
