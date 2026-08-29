// Copyright (C) 2022 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package com.google.gerrit.plugins.checks.jenkins;

import com.google.gerrit.extensions.annotations.PluginName;
import com.google.gerrit.server.config.PluginConfig;
import com.google.gerrit.server.config.PluginConfigFactory;
import com.google.gerrit.server.project.ProjectState;
import com.google.inject.Inject;
import com.google.inject.Singleton;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;
import org.eclipse.jgit.lib.Config;

/**
 * Shared reader for the plugin's Jenkins configuration.
 *
 * <p>Both the config REST endpoint and the proxy-trigger endpoint resolve the
 * {@code [jenkins "<instance>"]} sections of a project (inherited from its
 * parents, nearest level wins) with a fallback to the global plugin config.
 */
@Singleton
class JenkinsConfig {
  static final String JENKINS_SECTION = "jenkins";
  static final String JENKINS_URL_KEY = "url";
  static final String JENKINS_USER_KEY = "user";
  static final String JENKINS_TOKEN_KEY = "token";
  static final String JENKINS_COVERAGE_KEY = "coverage";
  static final String JENKINS_COVERAGE_ID_KEY = "coverage_id";

  private final PluginConfigFactory config;
  private final String pluginName;

  @Inject
  JenkinsConfig(PluginConfigFactory config, @PluginName String pluginName) {
    this.config = config;
    this.pluginName = pluginName;
  }

  /**
   * Collects every jenkins section from the project and all of its parents so a
   * project can, for example, add its own jenkins instance while still inheriting
   * the sonarqube instance from a parent. Sections are de-duplicated so that the
   * same server is never picked up twice: a section name defined on a project
   * shadows the same name inherited from a parent, and two sections pointing at
   * the same URL collapse into a single entry. Falls back to the global config
   * when no project-level section is defined.
   */
  Set<JenkinsChecksConfig> allInstances(ProjectState project) {
    PluginConfig globalConfig = config.getFromGerritConfig(pluginName);
    Set<JenkinsChecksConfig> result = new LinkedHashSet<>();
    Set<String> seenNames = new HashSet<>();
    Set<String> seenUrls = new HashSet<>();

    for (ProjectState state : project.tree()) {
      Config levelCfg = config.getProjectPluginConfig(state, pluginName);
      for (String instance : levelCfg.getSubsections(JENKINS_SECTION)) {
        if (!seenNames.add(instance)) {
          continue;
        }
        JenkinsChecksConfig jenkinsCfg = fromInstance(instance, levelCfg);
        if (jenkinsCfg.url != null && !seenUrls.add(serverKey(jenkinsCfg.url))) {
          continue;
        }
        result.add(jenkinsCfg);
      }
    }

    if (result.isEmpty() && globalConfig != null) {
      JenkinsChecksConfig jenkinsCfg = fromGlobal(globalConfig);
      if (jenkinsCfg.url != null && jenkinsCfg.user != null) {
        result.add(jenkinsCfg);
      }
    }
    return result;
  }

  /**
   * Resolves the named jenkins instance, returning its {@code url}, {@code user}
   * and {@code token}. A section on the project shadows the same name inherited
   * from a parent; when no project-level section defines the instance the global
   * config is used. Returns {@code null} when neither defines it.
   */
  Resolved resolve(String instance, ProjectState project) {
    for (ProjectState state : project.tree()) {
      Config cfg = config.getProjectPluginConfig(state, pluginName);
      if (!cfg.getSubsections(JENKINS_SECTION).contains(instance)) {
        continue;
      }
      return new Resolved(
          cfg.getString(JENKINS_SECTION, instance, JENKINS_URL_KEY),
          cfg.getString(JENKINS_SECTION, instance, JENKINS_USER_KEY),
          cfg.getString(JENKINS_SECTION, instance, JENKINS_TOKEN_KEY));
    }

    PluginConfig globalConfig = config.getFromGerritConfig(pluginName);
    if (globalConfig != null) {
      return new Resolved(
          globalConfig.getString(JENKINS_URL_KEY),
          globalConfig.getString(JENKINS_USER_KEY),
          globalConfig.getString(JENKINS_TOKEN_KEY));
    }
    return null;
  }

  private JenkinsChecksConfig fromInstance(String instance, Config cfg) {
    JenkinsChecksConfig jenkinsCfg = new JenkinsChecksConfig();
    jenkinsCfg.name = instance;
    jenkinsCfg.url = cfg.getString(JENKINS_SECTION, instance, JENKINS_URL_KEY);
    jenkinsCfg.user = cfg.getString(JENKINS_SECTION, instance, JENKINS_USER_KEY);
    jenkinsCfg.coverage_enabled =
        "true".equals(cfg.getString(JENKINS_SECTION, instance, JENKINS_COVERAGE_KEY));
    jenkinsCfg.coverage_id = cfg.getString(JENKINS_SECTION, instance, JENKINS_COVERAGE_ID_KEY);
    return jenkinsCfg;
  }

  private JenkinsChecksConfig fromGlobal(PluginConfig globalConfig) {
    JenkinsChecksConfig jenkinsCfg = new JenkinsChecksConfig();
    jenkinsCfg.name = "globalConfig";
    jenkinsCfg.url = globalConfig.getString(JENKINS_URL_KEY);
    jenkinsCfg.user = globalConfig.getString(JENKINS_USER_KEY);
    jenkinsCfg.coverage_enabled = "true".equals(globalConfig.getString(JENKINS_COVERAGE_KEY));
    jenkinsCfg.coverage_id = globalConfig.getString(JENKINS_COVERAGE_ID_KEY);
    return jenkinsCfg;
  }

  private static String serverKey(String url) {
    // Treat "https://host" and "https://host/" as the same server.
    return url.replaceAll("/+$", "");
  }

  static final class Resolved {
    final String url;
    final String user;
    final String token;

    Resolved(String url, String user, String token) {
      this.url = url;
      this.user = user;
      this.token = token;
    }
  }
}
