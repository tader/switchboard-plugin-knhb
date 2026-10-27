---
title: Using KNHB matches with an agent
services: [knhb]
---

# Using KNHB matches with an agent

Start with `getMyMatches` for personal matches and duties, and `getFavorites` for followed teams. A favorite may be a club, competition, international team or domestic team. For a domestic team use its numeric `id` and `recent_poule_id` in `getTeamPoule`. To discover another team, use `listClubs`, find the club’s `federation_reference_id`, then use `getClub`. Keep indoor and field teams separate even when their display names match.

Team responses put matches under `data.poules[].matches`. These contain the whole poule schedule: filter `home.id === teamId` or `away.id === teamId` before answering anything about the selected team. Other phases and previous seasons appear in `data.neighbors[]`; call `getTeamPoule` with each relevant neighbor’s `poule_id` and the same team ID. Do not confuse standings with match results.

The personal match feed includes `role`, `role_name`, `own_team_id`, `user_action_required` and `user_action_description`. Use KNHB’s actual role description to identify referee duties. Only claim that an assignment belongs to the connected account when the source says so. A child’s favorite team is a useful source of fixtures, but does not prove the child is playing. Family members can also connect their own KNHB accounts separately if needed.

For “How did we last play against HDM?”, establish which of the user’s teams they mean, load its team/poule results, filter the opponent in home or away, select completed matches, and sort newest first. Show the date and score in home–away order, making the user’s team clear. A scheduled match with score `0–0` is not a played draw. Follow the available poules for previous competition phases where needed, and report the historical range searched. Absence from a bounded feed does not prove teams never met.

For the family calendar, merge personal matches and each selected favorite team’s fixtures by KNHB match ID. Use `getMatch` to confirm the current date, venue, field, cancellation status and available officials. Interpret explicit timezone offsets and present local dates in `Europe/Amsterdam`, including daylight-saving changes. Preserve a date-only/unknown-time match as an all-day event; ask before assuming an end time. Do not invent a location, arrival time or referee assignment.

When a user requests calendar changes, use their calendar connection. Put the KNHB match ID and source connection in event metadata or description and look for an existing event before creating another. Refresh before updating a changed time or venue; distinguish cancelled fixtures and ask how the user wants existing cancelled events handled. This plugin only reads KNHB and cannot itself change favorites, match records or calendars.
