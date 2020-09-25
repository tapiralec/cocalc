/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: AGPLv3 s.t. "Commons Clause" – see LICENSE.md for details
 */

import { redux } from "../app-framework";

/*
Client-side throttling of running projects.  This may or may not be the
right approach to this problem... we'll see.

We allow a project to run if any of these conditions is satisfied:

   - the global limit on free projects has not been reached (or there is no global limit)
   - any license is applied to the project
   - any upgrades are applied to the project
   - admin member upgrade
   - is a project in a course (don't interfere with instructors/students)
   - project already running or starting for some reason
*/

function not_on_cocalc_com() {
  return window.location.host != "cocalc.com";
}

export function too_many_free_projects(): boolean {
  // there are never too many free projects if we're NOT on cocalc.com
  if (not_on_cocalc_com()) return false;

  const running_projects =
    redux.getStore("server_stats")?.getIn(["running_projects", "free"]) ?? 0;
  // limit of 0 means it is disabled.
  const free_limit =
    redux.getStore("customize")?.get("max_trial_projects") ?? 0;

  return free_limit > 0 && running_projects >= free_limit;
}

export function allow_project_to_run(project_id: string): boolean {
  function log(..._args) {
    //console.log("allow_project_to_run", ..._args);
  }
  if (not_on_cocalc_com()) {
    // For now we are hardcoding this functionality only for cocalc.com.
    // It will be made generic and configurable later once we have
    // **some experience** with it.
    log("not cocalc.com");
    return true;
  }

  const store = redux.getStore("projects");
  const state = store.get_state(project_id);
  if (state == "running" || state == "starting") {
    log("already running or starting");
    return true;
  }

  if (!too_many_free_projects()) {
    log("not too many projects");
    return true;
  }

  const project = store.getIn(["project_map", project_id]);
  if (project == null) {
    log("don't know project, maybe user is admin, maybe things aren't loaded");
    return true;
  }

  if (project.get("course") != null) {
    log("don't mess with students in course");
    return true;
  }

  const upgrades = store.get_total_project_upgrades(project_id);
  if (upgrades != null) {
    for (const name in upgrades) {
      if (upgrades[name]) {
        log("some upgrade exists, so run.");
        return true;
      }
    }
  }

  if (project.getIn(["settings", "member_host"])) {
    log("has admin upgrade of member hosting.");
    return true;
  }

  // maybe there is a license (valid or not -- we won't check at this point)
  if (store.get_site_license_ids(project_id).length > 0) {
    log("a license is applied");
    return true;
  }

  // got nothing:
  return false;
}