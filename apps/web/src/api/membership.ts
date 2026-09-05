import { get } from "./client";
import type { CurrentMembership, PlanView } from "../types/membership-types";

/** 会员 API（文档 §25） */
export const membershipApi = {
  current() {
    return get<CurrentMembership>("/api/membership/current");
  },
  plans() {
    return get<{ plans: PlanView[] }>("/api/membership/plans");
  },
};
