let body = "";

process.stdin.on("data", (chunk) => {
  body += chunk;
});

process.stdin.on("end", () => {
  const request = JSON.parse(body);
  process.stdout.write(
    JSON.stringify({
      answer: "4",
      task: request.task.id,
      model: request.model,
      config: request.config.id,
      prompt_style: request.config.parameters.prompt_style,
    }),
  );
});
