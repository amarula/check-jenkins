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

import com.google.common.flogger.FluentLogger;
import com.google.gerrit.extensions.restapi.BadRequestException;
import com.google.gerrit.plugins.checks.jenkins.ProxyTriggerAction.ProxyInput;
import com.google.gerrit.extensions.restapi.Response;
import com.google.gerrit.extensions.restapi.RestApiException;
import com.google.gerrit.extensions.restapi.RestModifyView;
import com.google.gerrit.plugins.checks.jenkins.JenkinsConfig.Resolved;
import com.google.gerrit.server.project.ProjectResource;
import com.google.inject.Inject;
import com.google.inject.Singleton;
import java.io.IOException;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.time.Duration;

@Singleton
public class ProxyTriggerAction implements RestModifyView<ProjectResource, ProxyInput> {
  private static final FluentLogger log = FluentLogger.forEnclosingClass();
  final int CONNECTION_TIMEOUT = 30;
  private final HttpClient httpClient = HttpClient.newBuilder()
      .connectTimeout(Duration.ofSeconds(CONNECTION_TIMEOUT)).build();
  final int REQUEST_TIMEOUT = 60;
  private final JenkinsConfig jenkinsConfig;

  @Inject
  ProxyTriggerAction(JenkinsConfig jenkinsConfig) {
    this.jenkinsConfig = jenkinsConfig;
  }

  @Override
  public Response<?> apply(ProjectResource resource, ProxyInput input)
      throws IOException, RestApiException, InterruptedException {
    String jenkinsName = input.jenkinsname;
    String urlPath = URLDecoder.decode(input.urlpath, StandardCharsets.UTF_8.toString());
    String method = input.method;

    if (urlPath == null || jenkinsName == null || urlPath.isEmpty() ||
        jenkinsName.isEmpty()) {
      throw new BadRequestException("jenkinsName is required");
    }

    Resolved resolved = jenkinsConfig.resolve(jenkinsName, resource.getProjectState());
    if (resolved == null || resolved.url == null || resolved.user == null ||
        resolved.token == null) {
      throw new BadRequestException("Invalid configuration jenkins auth or server url missing");
    }
    String jenkinsAuth = resolved.user + ":" + resolved.token;
    String targetUrl = resolved.url;

    String auth = Base64.getEncoder().encodeToString(jenkinsAuth.getBytes());
    String finalUrl = targetUrl + "/" + urlPath;

    HttpRequest jenkinsRequest;
    if (method == null || method.equalsIgnoreCase("GET")) {
      jenkinsRequest = HttpRequest.newBuilder()
          .uri(URI.create(finalUrl))
          .timeout(Duration.ofSeconds(REQUEST_TIMEOUT))
          .header("Authorization", "Basic " + auth)
          .GET()
          .build();
    } else if (method.equalsIgnoreCase("POST")) {
      /* Used for now only for rerun to be revisited */
      jenkinsRequest = HttpRequest.newBuilder()
          .uri(URI.create(finalUrl))
          .timeout(Duration.ofSeconds(REQUEST_TIMEOUT))
          .header("Authorization", "Basic " + auth)
          .POST(HttpRequest.BodyPublishers.noBody())
          .build();
    } else {
      throw new BadRequestException("Invalid parameters to communicate with Jenkins");
    }

    HttpResponse<String> response = httpClient.send(jenkinsRequest, HttpResponse.BodyHandlers.ofString());
    if (response.statusCode() >= 500) {
      log.atWarning().log("Jenkins server error: HTTP %d for %s", response.statusCode(), finalUrl);
      return Response.ok("{\"_jenkins_unavailable\": true}");
    }
    return Response.withStatusCode(response.statusCode(), response.body());
  }

  static class ProxyInput {
    public String jenkinsname;
    public String urlpath;
    public String method;
  }
}
